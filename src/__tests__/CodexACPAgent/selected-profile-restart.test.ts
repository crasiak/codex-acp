import {afterEach, describe, expect, it, vi} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {once} from "node:events";
import {startCodexConnection} from "../../CodexJsonRpcConnection";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAcpServer, type CodexProcessState} from "../../CodexAcpServer";
import {createMockConnections} from "./test-utils";

describe("selected profile across an app-server restart", () => {
    afterEach(() => vi.unstubAllEnvs());

    it.skipIf(process.platform === "win32")("keeps the profile on the replacement process and client", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-profile-restart-"));
        const argvLog = path.join(dir, "argv.log");
        const fakeCodex = path.join(dir, "codex");
        // Records its arguments, then stays up until stdin closes, like app-server.
        fs.writeFileSync(fakeCodex, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec cat >/dev/null\n`);
        fs.chmodSync(fakeCodex, 0o755);
        vi.stubEnv("CODEX_PROFILE", "work");

        const connection = startCodexConnection(fakeCodex);
        const state: CodexProcessState = {
            connection, codexPath: fakeCodex, config: undefined, modelProvider: undefined, stderr: "",
        };
        const agent = new CodexAcpServer(
            createMockConnections().mockAcpConnection,
            new CodexAcpClient(new CodexAppServerClient(connection.connection), undefined, undefined, connection.profile),
            undefined,
            undefined,
            undefined,
            state,
        );

        // restartCodexClient is the provider-update path; it is private.
        const replacement: CodexAcpClient = await (agent as any).restartCodexClient();
        try {
            expect(state.connection).not.toBe(connection);
            expect(state.connection.profile).toBe("work");
            expect((replacement as any).selectedProfile).toBe("work");
            await vi.waitFor(() => {
                expect(fs.readFileSync(argvLog, "utf8").trim().split("\n"))
                    .toEqual(["--profile work app-server", "--profile work app-server"]);
            });
        } finally {
            const exited = once(state.connection.process, "exit");
            state.connection.process.stdin.end();
            await exited;
        }
    }, 15_000);
});
