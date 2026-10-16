import * as rpc from "vscode-jsonrpc/node";
import type {MessageConnection} from "vscode-jsonrpc/node";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {isAbsolute} from "node:path";

import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";
import {logger} from "./Logger";

export interface CodexConnection {
    readonly connection: MessageConnection
    readonly process: ChildProcessWithoutNullStreams;
    readonly profile?: string;
    /** Present only for protected startup; reused unchanged on process recreation. */
    readonly protectedStartupEnv?: NodeJS.ProcessEnv;
}

export function startCodexConnection(codexPath?: string, env?: NodeJS.ProcessEnv): CodexConnection {
    const sourceEnv = env ?? process.env;
    const protectedStartupEnv = sourceEnv["CODEX_APP_SERVER_CONFIG"] === undefined
        ? undefined : Object.freeze({...sourceEnv});
    const spawnEnv = protectedStartupEnv ?? sourceEnv;
    const profile = spawnEnv["CODEX_PROFILE"];
    if (profile !== undefined && (profile.length === 0 || /[^a-zA-Z0-9_-]/.test(profile))) {
        throw new Error("CODEX_PROFILE must be a plain profile name");
    }
    const overrides = protectedStartupEnv === undefined ? [] : protectedConfigArgs(codexPath, spawnEnv);
    const args = [...(profile === undefined ? [] : ['--profile', profile]), ...overrides, 'app-server'];

    let codex: ChildProcessWithoutNullStreams;
    if (codexPath) {
        codex = process.platform === 'win32'
            ? spawn(`"${codexPath}" ${args.join(' ')}`, { shell: true, env: spawnEnv })
            : spawn(codexPath, args, { env: spawnEnv });
    } else {
        const bundledCodexPath = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
        codex = spawn(process.execPath, [bundledCodexPath, ...args], {env: spawnEnv});
    }

    attachLogs(codex);

    const reader = createJSONRPCReader(codex.stdout);
    const writer = createJSONRPCWriter(codex.stdin);

    let connection = rpc.createMessageConnection(reader, writer);

    connection.listen();

    // Terminate all current activities on process termination
    codex.on("exit", _ => {
        connection.dispose();
    });

    return {
        connection, process: codex,
        ...(profile === undefined ? {} : {profile}),
        ...(protectedStartupEnv === undefined ? {} : {protectedStartupEnv}),
    };
}

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The model provider a protected startup selects (its `model_provider="..."`
 * override), or undefined. app-server rebuilds each thread's config from its
 * layers, where a managed (MDM) `model_provider` outranks the startup `-c`, so
 * the shim passes this explicitly at thread start (CRA-955).
 */
export function protectedModelProvider(env: NodeJS.ProcessEnv): string | undefined {
    const raw = env["CODEX_APP_SERVER_CONFIG"];
    if (raw === undefined) {
        return undefined;
    }
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) {
        return undefined;
    }
    for (const entry of entries) {
        if (typeof entry !== "string" || !entry.startsWith("model_provider=")) {
            continue;
        }
        const match = /^model_provider="([A-Za-z0-9_-]+)"$/.exec(entry);
        if (!match) {
            throw new Error("CODEX_APP_SERVER_CONFIG model_provider must be a quoted plain provider id");
        }
        return match[1];
    }
    return undefined;
}

function protectedConfigArgs(codexPath: string | undefined, env: NodeJS.ProcessEnv): string[] {
    if (process.platform === "win32") {
        throw new Error("CODEX_APP_SERVER_CONFIG is unsupported on Windows (shell startup is not permitted)");
    }
    if (env["CODEX_PROFILE"] === undefined) {
        throw new Error("CODEX_APP_SERVER_CONFIG requires CODEX_PROFILE");
    }
    if (!codexPath || codexPath !== env["CODEX_PATH"] || !isAbsolute(codexPath) || controlCharacters.test(codexPath)) {
        throw new Error("CODEX_APP_SERVER_CONFIG requires an exact absolute CODEX_PATH executable");
    }
    if (env["CODEX_CONFIG"] !== undefined || env["MODEL_PROVIDER"] !== undefined) {
        throw new Error("CODEX_APP_SERVER_CONFIG cannot be combined with CODEX_CONFIG or MODEL_PROVIDER");
    }
    const raw = env["CODEX_APP_SERVER_CONFIG"]!;
    if (Buffer.byteLength(raw, "utf8") > 65536) {
        throw new Error("CODEX_APP_SERVER_CONFIG exceeds 65536 UTF-8 bytes");
    }
    let entries: unknown;
    try {
        entries = JSON.parse(raw);
    } catch {
        throw new Error("CODEX_APP_SERVER_CONFIG must be a JSON array of key=value strings");
    }
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 64) {
        throw new Error("CODEX_APP_SERVER_CONFIG must contain 1 to 64 overrides");
    }
    return entries.flatMap((entry: unknown, index) => {
        // Deliberately only structural validation, not a TOML parser. Values are
        // interpreted by native Codex; bare dotted keys avoid ambiguous key syntax.
        if (typeof entry !== "string" || Buffer.byteLength(entry, "utf8") > 8192
            || controlCharacters.test(entry) || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*=\s*\S/.test(entry)) {
            throw new Error(`CODEX_APP_SERVER_CONFIG entry ${index} must be a nonempty bare dotted key=value string, at most 8192 UTF-8 bytes, without control characters`);
        }
        return ["-c", entry];
    });
}

function attachLogs(proc: ChildProcessWithoutNullStreams) {
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk: any, encoding?: any, callback?: any): boolean => {
        logger.log(`[IN] ${chunk.toString()}`);
        return originalWrite(chunk, encoding, callback);
    };

    proc.stderr.on("data", (data) => {
        logger.log(`[ERR] ${data.toString()}`);
    });
    proc.stdout.on("data", (data: Buffer) => {
        logger.log(`[OUT] ${data.toString()}`);
    });
    proc.on("exit", (code) => {
        logger.log(`[EXIT] code: ${code?.toString()}`);
    });
}
