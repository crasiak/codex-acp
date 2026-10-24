import {afterEach, describe, expect, it, vi} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {once} from "node:events";
import {startCodexConnection, type CodexConnection} from "../../CodexJsonRpcConnection";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {CodexAcpClient} from "../../CodexAcpClient";

// CRA-357 on the 2.2 recovery design: the supervisor restarts a crashed
// app-server through startCodexConnection (with the same startup args) and
// builds the replacement client with CodexAcpClient.withAppServer. Both must
// keep the selected profile.
describe("selected profile across an app-server restart", () => {
    afterEach(() => vi.unstubAllEnvs());

    async function stop(connection: CodexConnection) {
        const exited = once(connection.process, "exit");
        connection.process.stdin.end();
        await exited;
    }

    it.skipIf(process.platform === "win32")("every start runs the profile before the computed startup args", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-profile-restart-"));
        const argvLog = path.join(dir, "argv.log");
        const fakeCodex = path.join(dir, "codex");
        // Records its arguments, then stays up until stdin closes, like app-server.
        fs.writeFileSync(fakeCodex, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec cat >/dev/null\n`);
        fs.chmodSync(fakeCodex, 0o755);
        vi.stubEnv("CODEX_PROFILE", "work");
        const startupArgs = ["app-server", "-c", "hooks={}"];

        const first = startCodexConnection(fakeCodex, undefined, startupArgs, {disposeOnExit: false});
        const second = startCodexConnection(fakeCodex, undefined, startupArgs, {disposeOnExit: false});
        try {
            expect(first.profile).toBe("work");
            expect(second.profile).toBe("work");
            await vi.waitFor(() => {
                expect(fs.readFileSync(argvLog, "utf8").trim().split("\n"))
                    .toEqual(["--profile work app-server -c hooks={}", "--profile work app-server -c hooks={}"]);
            });
        } finally {
            await stop(first);
            await stop(second);
        }
    }, 15_000);

    it.skipIf(process.platform === "win32")("the replacement client keeps the selected profile", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-profile-client-"));
        const fakeCodex = path.join(dir, "codex");
        fs.writeFileSync(fakeCodex, "#!/bin/sh\nexec cat >/dev/null\n");
        fs.chmodSync(fakeCodex, 0o755);
        const connection = startCodexConnection(fakeCodex);
        try {
            const original = new CodexAcpClient(new CodexAppServerClient(connection.connection), undefined, undefined, "work");
            const replacement = original.withAppServer(new CodexAppServerClient(connection.connection));
            expect((replacement as any).selectedProfile).toBe("work");
        } finally {
            await stop(connection);
        }
    }, 15_000);

    it("rejects a profile that is not a plain name", () => {
        vi.stubEnv("CODEX_PROFILE", "work;rm");
        expect(() => startCodexConnection("/not-executed")).toThrow("CODEX_PROFILE must be a plain profile name");
    });
});
