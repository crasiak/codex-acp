import {describe, expect, it} from "vitest";
import {protectedModelProvider} from "../CodexJsonRpcConnection";

// app-server rebuilds each thread's config from its layers, where a managed
// (MDM) model_provider outranks the startup `-c`; the shim passes the
// protected provider explicitly at thread start instead (CRA-955).
describe("protectedModelProvider", () => {
    it("reads the model_provider override", () => {
        expect(protectedModelProvider({CODEX_APP_SERVER_CONFIG: JSON.stringify([
            'openai_base_url="http://127.0.0.1:9"', 'model_provider="ledger_isolated_openai"',
        ])})).toBe("ledger_isolated_openai");
    });
    it("is absent without protected startup or without the key", () => {
        expect(protectedModelProvider({})).toBeUndefined();
        expect(protectedModelProvider({CODEX_APP_SERVER_CONFIG: JSON.stringify(['openai_base_url="x"'])})).toBeUndefined();
    });
    it("refuses a malformed provider value rather than guessing", () => {
        expect(() => protectedModelProvider({CODEX_APP_SERVER_CONFIG: JSON.stringify(["model_provider=ledger"])})).toThrow();
        expect(() => protectedModelProvider({CODEX_APP_SERVER_CONFIG: JSON.stringify(['model_provider="a b"'])})).toThrow();
    });
});
