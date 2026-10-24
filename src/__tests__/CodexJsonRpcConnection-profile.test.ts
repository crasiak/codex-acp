import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {spawn} from "node:child_process";
import crossSpawn from "cross-spawn";
import {startCodexConnection, type CodexConnection} from "../CodexJsonRpcConnection";

vi.mock("node:child_process", () => ({spawn: vi.fn()}));
// 2.2 starts a Windows Codex through cross-spawn, not a shell string.
vi.mock("cross-spawn", () => ({default: vi.fn()}));

describe("selected app-server profile", () => {
    let connection: CodexConnection | undefined;

    beforeEach(() => {
        const fakeProcess = () => Object.assign(new EventEmitter(), {
            stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        });
        vi.mocked(spawn).mockImplementation(() => fakeProcess() as unknown as ReturnType<typeof spawn>);
        vi.mocked(crossSpawn).mockImplementation(() => fakeProcess() as unknown as ReturnType<typeof crossSpawn>);
    });

    afterEach(() => {
        connection?.connection.dispose();
        connection = undefined;
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it.each(["", "../work", "work.config.toml", "work profile", "work&echo", "work\n"])(
        "refuses invalid profile %j before spawning", profile => {
            expect(() => startCodexConnection("/fake/codex", {CODEX_PROFILE: profile}))
                .toThrow("CODEX_PROFILE must be a plain profile name");
            expect(spawn).not.toHaveBeenCalled();
        },
    );

    it.each(["linux", "darwin", "win32"])("forwards one validated profile on %s", platform => {
        vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
        const env = {CODEX_PROFILE: "work_2-personal"};
        connection = startCodexConnection("/fake/codex", env);
        expect(connection.profile).toBe("work_2-personal");
        if (platform === "win32") {
            expect(crossSpawn).toHaveBeenCalledWith("/fake/codex", ["--profile", "work_2-personal", "app-server"], {env});
        } else {
            expect(spawn).toHaveBeenCalledWith("/fake/codex", ["--profile", "work_2-personal", "app-server"], {env});
        }
    });

    it("passes the profile through the bundled Node entrypoint", () => {
        const env = {CODEX_PROFILE: "work"};
        connection = startCodexConnection(undefined, env);
        expect(spawn).toHaveBeenCalledWith(process.execPath, [
            expect.stringMatching(/codex\.js$/), "--profile", "work", "app-server",
        ], {env});
    });

    it("preserves unselected startup", () => {
        connection = startCodexConnection("/fake/codex", {});
        expect(connection.profile).toBeUndefined();
        expect(spawn).toHaveBeenCalledWith("/fake/codex", ["app-server"], {env: {}});
    });
});
