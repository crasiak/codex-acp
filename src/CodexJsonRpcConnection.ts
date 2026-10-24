import * as rpc from "vscode-jsonrpc/node";
import type {Message} from "vscode-jsonrpc/node";
import type {MessageConnection} from "vscode-jsonrpc/node";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createRequire} from "node:module";
import {isAbsolute} from "node:path";
import crossSpawn from "cross-spawn";

import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";
import {logger} from "./Logger";

const require = createRequire(import.meta.url);

export interface CodexConnection {
    readonly connection: MessageConnection
    readonly process: ChildProcessWithoutNullStreams;
    /**
     * Settles once the connection has handled every message that the process wrote before its stdout ended.
     * `CodexAppServerSupervisor` waits for it before it disposes the connection of a dead process.
     */
    readonly drained?: Promise<void>;
    /** The `CODEX_PROFILE` this app-server was started with (CRA-357). */
    readonly profile?: string;
    /** Present only for protected startup; reused unchanged on process recreation (CRA-955). */
    readonly protectedStartupEnv?: NodeJS.ProcessEnv;
}

/** A notification that the adapter feeds into the connection after the last message of the process. */
const DRAINED_MARKER_METHOD = "codex-acp/stdoutDrained";

export interface StartCodexConnectionOptions {
    /**
     * Dispose the connection when the process exits (default). `CodexAppServerSupervisor` turns it off: it disposes
     * the connection itself, after the last output of the process was read.
     */
    disposeOnExit?: boolean;
}

export function startCodexConnection(
    codexPath?: string,
    env?: NodeJS.ProcessEnv,
    appServerStartupArgs: string[] = ["app-server"],
    options: StartCodexConnectionOptions = {},
): CodexConnection {
    const sourceEnv = env ?? process.env;
    // CRA-955: protected startup freezes its environment once; a restart is
    // handed the same snapshot, so later process.env changes cannot alter it.
    const protectedStartupEnv = sourceEnv["CODEX_APP_SERVER_CONFIG"] === undefined
        ? undefined : Object.freeze({...sourceEnv});
    const spawnEnv = protectedStartupEnv ?? sourceEnv;
    // CRA-357: a selected Codex profile is a startup flag, validated here so
    // every start (the first and each supervisor restart) carries the same one.
    const profile = spawnEnv["CODEX_PROFILE"];
    if (profile !== undefined && (profile.length === 0 || /[^a-zA-Z0-9_-]/.test(profile))) {
        throw new Error("CODEX_PROFILE must be a plain profile name");
    }
    const overrides = protectedStartupEnv === undefined ? [] : protectedConfigArgs(codexPath, spawnEnv);
    // Global flags precede the subcommand and its own computed args.
    const startupArgs = [...(profile === undefined ? [] : ["--profile", profile]), ...overrides, ...appServerStartupArgs];

    let codex: ChildProcessWithoutNullStreams;
    if (codexPath) {
        // cross-spawn runs `.cmd` shims through cmd.exe with correct escaping for the TOML hook override.
        codex = process.platform === "win32"
            ? crossSpawn(codexPath, startupArgs, {env: spawnEnv}) as ChildProcessWithoutNullStreams
            : spawn(codexPath, startupArgs, {env: spawnEnv});
    } else {
        const bundledCodexPath = require.resolve("@openai/codex/bin/codex.js");
        codex = spawn(process.execPath, [bundledCodexPath, ...startupArgs], {env: spawnEnv});
    }

    attachLogs(codex);
    // A write to a process that is dying fails with EPIPE. Without a listener that error would end the adapter.
    codex.stdin.on("error", (error) => logger.log(`[STDIN ERROR] ${error.message}`));
    codex.stdout.on("error", (error) => logger.log(`[STDOUT ERROR] ${error.message}`));

    const reader = createJSONRPCReader(codex.stdout);
    const writer = createJSONRPCWriter(codex.stdin);

    let connection = rpc.createMessageConnection(reader, writer);

    connection.listen();

    // vscode-jsonrpc handles the messages that it read one by one, after the read. The marker comes after the last
    // message of the process, so its handler runs only when every earlier message was handled.
    const drained = new Promise<void>(resolve => {
        connection.onNotification(DRAINED_MARKER_METHOD, () => resolve());
    });
    codex.stdout.on("end", () => reader.deliver?.({jsonrpc: "2.0", method: DRAINED_MARKER_METHOD} as Message));

    if (options.disposeOnExit ?? true) {
        // Terminate all current activities on process termination
        codex.on("exit", _ => {
            connection.dispose();
        });
    }

    return {
        connection, process: codex, drained,
        ...(profile === undefined ? {} : {profile}),
        ...(protectedStartupEnv === undefined ? {} : {protectedStartupEnv}),
    };
}

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;

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

/**
 * Logs the traffic of the app-server.
 * The listeners stay attached when logging is off, so that stderr keeps draining,
 * but a chunk is turned into a string only when the logger writes it.
 */
export function attachLogs(proc: ChildProcessWithoutNullStreams) {
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk: any, encoding?: any, callback?: any): boolean => {
        if (logger.enabled) logger.log(`[IN] ${chunk.toString()}`);
        return originalWrite(chunk, encoding, callback);
    };

    proc.stderr.on("data", (data) => {
        if (logger.enabled) logger.log(`[ERR] ${data.toString()}`);
    });
    proc.stdout.on("data", (data: Buffer) => {
        if (logger.enabled) logger.log(`[OUT] ${data.toString()}`);
    });
    proc.on("exit", (code) => {
        logger.log(`[EXIT] code: ${code?.toString()}`);
    });
}
