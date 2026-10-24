import {afterEach, describe, expect, it, vi} from "vitest";
import type {McpServer} from "@agentclientprotocol/sdk";
import {CodexAcpClient} from "../../CodexAcpClient";
import {createCodexMockTestFixture} from "../acp-test-utils";
import type {ConfigReadResponse} from "../../app-server/v2";
import type {JsonValue} from "../../app-server/serde_json/JsonValue";

const venue: McpServer = {name: "venue", type: "http", url: "http://127.0.0.1:1/mcp", headers: []};
const selected = {selected: {command: "/not-executed", args: []}};

describe("selected-profile MCP composition", () => {
    afterEach(() => vi.unstubAllEnvs());

    function setup(config: Record<string, JsonValue> = {mcp_servers: selected}, profile: string | null = "work") {
        const fixture = createCodexMockTestFixture();
        const native = fixture.getCodexAppServerClient();
        vi.spyOn(native, "listSkills").mockResolvedValue({data: []});
        // Only MCP fields are read by this fixture; the transport is mocked.
        const read = vi.spyOn(native, "configRead").mockResolvedValue({config: {}, layers: [], origins: {}} as unknown as ConfigReadResponse);
        const start = vi.spyOn(native, "threadStart").mockRejectedValue(new Error("captured thread/start"));
        const resume = vi.spyOn(native, "threadResume").mockRejectedValue(new Error("captured thread/resume"));
        return {client: new CodexAcpClient(native, config, undefined, profile ?? undefined), read, start, resume};
    }

    for (const operation of ["newSession", "loadSession", "resumeSession"] as const) {
        it(`${operation} preserves selected servers and adds the venue`, async () => {
            const {client, start, resume} = setup();
            await expect(client[operation]({cwd: "/fixture", sessionId: "existing", mcpServers: [venue]}))
                .rejects.toThrow("captured thread/");
            const call = operation === "newSession" ? start : resume;
            expect(call).toHaveBeenCalledWith(expect.objectContaining({config: expect.objectContaining({
                mcp_servers: {...selected, venue: {url: venue.url, http_headers: {}}},
            })}));
        });
    }

    it("keeps native selected MCP collision checks with protected startup enabled", async () => {
        vi.stubEnv("CODEX_APP_SERVER_CONFIG", JSON.stringify(['mcp_servers.selected.command="/not-executed"']));
        const {client, read, start} = setup({});
        read.mockResolvedValue({config: {mcp_servers: selected}, layers: [], origins: {}} as unknown as ConfigReadResponse);
        await expect(client.newSession({cwd: "/fixture", mcpServers: [venue]})).rejects.toThrow("captured thread/start");
        expect(start).toHaveBeenCalledWith(expect.objectContaining({config: expect.objectContaining({
            mcp_servers: {venue: {url: venue.url, http_headers: {}}},
        })}));
        start.mockClear();
        await expect(client.newSession({cwd: "/fixture", mcpServers: [{...venue, name: "selected"}]}))
            .rejects.toMatchObject({code: -32602});
        expect(start).not.toHaveBeenCalled();
    });

    it.each(["false", "true"])("rejects a selected override collision with filtering=%s", filtering => {
        vi.stubEnv("DISABLE_MCP_CONFIG_FILTERING", filtering);
        const {client, start} = setup({mcp_servers: {venue: {command: "/not-executed", args: []}}});
        return expect(client.newSession({cwd: "/fixture", mcpServers: [venue]}))
            .rejects.toMatchObject({code: -32602}).then(() => expect(start).not.toHaveBeenCalled());
    });

    it.each(["effective", "layer"])("rejects a collision from a %s config", async source => {
        const {client, read, start} = setup();
        read.mockResolvedValue({config: source === "effective" ? {mcp_servers: {venue: {url: "http://ambient.invalid"}}} : {},
            layers: source === "layer" ? [{config: {mcp_servers: {venue: {enabled: false}}}}] : [], origins: {}} as unknown as ConfigReadResponse);
        await expect(client.newSession({cwd: "/fixture", mcpServers: [venue]})).rejects.toMatchObject({code: -32602});
        expect(start).not.toHaveBeenCalled();
    });

    it("rejects requested names which collide after sanitization", async () => {
        const {client, start} = setup();
        await expect(client.newSession({cwd: "/fixture", mcpServers: [
            {...venue, name: "my venue"}, {...venue, name: "my_venue"},
        ]})).rejects.toMatchObject({code: -32602});
        expect(start).not.toHaveBeenCalled();
    });

    it("fails closed when effective configuration cannot be read", async () => {
        const {client, read, start} = setup();
        read.mockRejectedValue(new Error("config unavailable"));
        await expect(client.newSession({cwd: "/fixture", mcpServers: [venue]})).rejects.toThrow("config unavailable");
        expect(start).not.toHaveBeenCalled();
    });

    it("preserves existing unselected filtering", async () => {
        const {client, read, start} = setup(undefined, null);
        read.mockResolvedValue({config: {mcp_servers: {venue: {url: "http://ambient.invalid"}}}, layers: [], origins: {}} as unknown as ConfigReadResponse);
        await expect(client.newSession({cwd: "/fixture", mcpServers: [venue]})).rejects.toThrow("captured thread/start");
        expect(start).toHaveBeenCalledWith(expect.objectContaining({config: expect.objectContaining({mcp_servers: selected})}));
    });
});
