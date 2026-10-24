import {afterEach, describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture} from "../acp-test-utils";

// Under protected startup (CODEX_APP_SERVER_CONFIG, CRA-955) the account
// belongs to the host (Ledger): the shim reports an auth failure but must
// never log the account out, which would delete the stored login.
describe("Protected startup never logs out", () => {
    afterEach(() => vi.unstubAllEnvs());

    for (const message of [
        `Internal error: "failed to reload config: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."`,
        `Internal error: "failed to reload config: Failed to load cloud requirements (workspace-managed policies)."`,
    ]) {
        it(`reports without logging out: ${message.slice(40, 90)}`, async () => {
            vi.stubEnv("CODEX_APP_SERVER_CONFIG", "[]");
            const fixture = createCodexMockTestFixture();
            const codexAcpClient = fixture.getCodexAcpClient();
            vi.spyOn(codexAcpClient, "readAuthRequirement").mockResolvedValue({required: false, account: null});
            vi.spyOn(fixture.getCodexAppServerClient(), "threadStart").mockRejectedValue(new Error(message));
            const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();

            await expect(fixture.getCodexAcpAgent().newSession({cwd: "", mcpServers: []}))
                .rejects.toMatchObject({data: expect.stringContaining("sign in again in the host")});
            expect(logoutSpy).not.toHaveBeenCalled();
        });
    }
});
