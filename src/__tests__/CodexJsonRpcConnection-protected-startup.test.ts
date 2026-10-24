import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {spawn} from "node:child_process";
import {startCodexConnection, type CodexConnection} from "../CodexJsonRpcConnection";
import {CodexAppServerClient} from "../CodexAppServerClient";
import {CodexAcpClient} from "../CodexAcpClient";
import {CodexAppServerSupervisor} from "../app-server-recovery/CodexAppServerSupervisor";

vi.mock("node:child_process", () => ({spawn: vi.fn()}));

const codexPath = "/trusted runtime/codex";
const overrides = [
    'model_provider="private"',
    'model_providers.private.base_url="http://localhost:1234/a b?x=1"',
    'model_providers.private.http_headers={ Authorization = "Bearer quoted \\\"token\\\"" }',
    'mcp_servers.selected.args=["two words", "$(not-a-shell)"]',
];
const protectedEnv = (): NodeJS.ProcessEnv => ({
    CODEX_PATH: codexPath,
    CODEX_PROFILE: "selected_work",
    CODEX_APP_SERVER_CONFIG: JSON.stringify(overrides),
    PRIVATE_TOKEN: "inherited unchanged",
});
const expectedArgs = ["--profile", "selected_work", ...overrides.flatMap(value => ["-c", value]), "app-server"];

describe("protected native startup", () => {
    const connections: CodexConnection[] = [];
    beforeEach(() => {
        vi.spyOn(process, "platform", "get").mockReturnValue("linux");
        vi.mocked(spawn).mockImplementation(() => {
            const child = Object.assign(new EventEmitter(), {
                stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null,
            });
            child.stdin.on("finish", () => child.emit("exit", 0));
            return child as unknown as ReturnType<typeof spawn>;
        });
    });
    afterEach(() => {
        connections.splice(0).forEach(connection => connection.connection.dispose());
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it.each(["linux", "darwin"])("retains profile and exact argv without shell on %s", platform => {
        vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
        const env = Object.freeze(protectedEnv());
        const before = {...process.env};
        const connection = startCodexConnection(codexPath, env);
        connections.push(connection);
        expect(connection.profile).toBe("selected_work");
        expect(spawn).toHaveBeenCalledExactlyOnceWith(codexPath, expectedArgs, {env});
        expect(process.env).toEqual(before);
        expect(env).toEqual(protectedEnv());
    });

    it("inherits process env without mutation when no env argument is supplied", () => {
        for (const [key, value] of Object.entries(protectedEnv())) vi.stubEnv(key, value);
        vi.stubEnv("CODEX_CONFIG", undefined);
        vi.stubEnv("MODEL_PROVIDER", undefined);
        const before = {...process.env};
        connections.push(startCodexConnection(codexPath));
        expect(spawn).toHaveBeenCalledExactlyOnceWith(codexPath, expectedArgs, {env: before});
        expect(process.env).toEqual(before);
    });

    it("accepts size boundaries and leaves value interpretation to native Codex", () => {
        const entries = [`model=${"x".repeat(8186)}`, ...Array(63).fill("feature=true")];
        const env = {...protectedEnv(), CODEX_APP_SERVER_CONFIG: JSON.stringify(entries).padEnd(65536, " ")};
        connections.push(startCodexConnection(codexPath, env));
        expect(spawn).toHaveBeenCalledExactlyOnceWith(codexPath, [
            "--profile", "selected_work", ...entries.flatMap(value => ["-c", value]), "app-server",
        ], {env});
    });

    it("does not echo a malformed secret-bearing override in errors", () => {
        expect(() => startCodexConnection(codexPath, {
            ...protectedEnv(), CODEX_APP_SERVER_CONFIG: '["header=secret-token',
        })).toThrow(/^CODEX_APP_SERVER_CONFIG must be a JSON array of key=value strings$/);
        expect(spawn).not.toHaveBeenCalled();
    });

    it.each([
        ["empty", ""], ["invalid JSON", "["], ["object", "{}"], ["null", "null"],
        ["string", '"model=1"'], ["empty array", "[]"], ["non-string", "[1]"],
        ["empty entry", '[""]'], ["flag", '["--dangerously-bypass-approvals-and-sandbox"]'],
        ["flag assignment", '["--version=true"]'], ["short flag assignment", '["-h=true"]'],
        ["no assignment", '["model"]'], ["empty value", '["model=  "]'],
        ["empty key", '["=true"]'], ["empty key segment", '["model..name=true"]'],
        ["quoted key", JSON.stringify(['"model"=true'])], ["key whitespace", '["model name=true"]'],
        ["newline", JSON.stringify(['model="a"\nother=true'])],
        ["NUL", JSON.stringify(['model="\u0000"'])], ["tab", JSON.stringify(['model="\t"'])],
        ["DEL", JSON.stringify(['model="\u007f"'])], ["C1", JSON.stringify(['model="\u0085"'])],
        ["too many entries", JSON.stringify(Array(65).fill("model=true"))],
        ["entry too large", JSON.stringify([`model="${"x".repeat(8192)}"`])],
        ["UTF-8 entry too large", JSON.stringify([`model="${"é".repeat(4096)}"`])],
        ["JSON too large", JSON.stringify(Array(10).fill(`model="${"x".repeat(7000)}"`))],
    ])("rejects %s before spawn", (_label, config) => {
        expect(() => startCodexConnection(codexPath, {...protectedEnv(), CODEX_APP_SERVER_CONFIG: config}))
            .toThrow(/CODEX_APP_SERVER_CONFIG/);
        expect(spawn).not.toHaveBeenCalled();
    });

    it.each([
        {CODEX_PROFILE: undefined}, {CODEX_PROFILE: ""},
        {CODEX_PATH: undefined}, {CODEX_PATH: ""}, {CODEX_PATH: "codex"},
        {CODEX_PATH: "/different/codex"}, {CODEX_PATH: "/trusted\n/codex"},
        {CODEX_CONFIG: "{}"}, {CODEX_CONFIG: ""}, {MODEL_PROVIDER: "private"}, {MODEL_PROVIDER: ""},
    ])("rejects missing or competing startup inputs %j", change => {
        expect(() => startCodexConnection(codexPath, {...protectedEnv(), ...change})).toThrow(/CODEX_|MODEL_PROVIDER/);
        expect(spawn).not.toHaveBeenCalled();
    });

    it("requires an explicit absolute executable, not bundled or PATH resolution", () => {
        expect(() => startCodexConnection(undefined, protectedEnv())).toThrow(/CODEX_PATH/);
        expect(() => startCodexConnection("codex", {...protectedEnv(), CODEX_PATH: "codex"})).toThrow(/CODEX_PATH/);
        expect(spawn).not.toHaveBeenCalled();
    });

    it("refuses Windows rather than using its shell launch path", () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        expect(() => startCodexConnection(codexPath, protectedEnv())).toThrow(/Windows/);
        expect(spawn).not.toHaveBeenCalled();
    });

    it("leaves existing inputs alone when the seam is absent", () => {
        const env = {CODEX_PROFILE: "work", CODEX_CONFIG: "{}", MODEL_PROVIDER: "other"};
        connections.push(startCodexConnection("codex", env));
        expect(spawn).toHaveBeenCalledExactlyOnceWith("codex", ["--profile", "work", "app-server"], {env});
    });

    it("restarts from the frozen protected env through the supervisor's spawn", () => {
        // 2.2 restarts a crashed or provider-restarted app-server through
        // CodexAppServerSupervisor; its default spawn must reuse the previous
        // connection's frozen protected env, never the live process env.
        const env = protectedEnv();
        const connection = startCodexConnection(codexPath, env);
        connections.push(connection);
        const state = {connection, codexPath, appServerStartupArgs: ["app-server"], stderr: ""};
        const supervisor = new CodexAppServerSupervisor(state as any);
        env["CODEX_APP_SERVER_CONFIG"] = "[]";
        env["PRIVATE_TOKEN"] = "changed";
        vi.stubEnv("CODEX_APP_SERVER_CONFIG", "[]");
        vi.stubEnv("CODEX_PROFILE", "different");
        for (let i = 0; i < 2; i++) {
            const next: CodexConnection = (supervisor as any).spawnConnection(codexPath, state.appServerStartupArgs);
            connections.push(next);
            state.connection = next;
            expect(next.profile).toBe("selected_work");
        }
        const client = new CodexAcpClient(new CodexAppServerClient(connection.connection), undefined, undefined, connection.profile);
        expect((client.withAppServer(new CodexAppServerClient(state.connection.connection)) as any).selectedProfile).toBe("selected_work");
        expect(spawn).toHaveBeenCalledTimes(3);
        for (const call of vi.mocked(spawn).mock.calls) {
            expect(call).toEqual([codexPath, expectedArgs, {env: protectedEnv()}]);
        }
    });
});
