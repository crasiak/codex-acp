import * as rpc from "vscode-jsonrpc/node";
import type {MessageConnection} from "vscode-jsonrpc/node";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";

import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";
import {logger} from "./Logger";

export interface CodexConnection {
    readonly connection: MessageConnection
    readonly process: ChildProcessWithoutNullStreams;
    readonly profile?: string;
}

export function startCodexConnection(codexPath?: string, env?: NodeJS.ProcessEnv): CodexConnection {
    const spawnEnv = env ?? process.env;
    const profile = spawnEnv["CODEX_PROFILE"];
    if (profile !== undefined && (profile.length === 0 || /[^a-zA-Z0-9_-]/.test(profile))) {
        throw new Error("CODEX_PROFILE must be a plain profile name");
    }
    const args = profile === undefined ? ['app-server'] : ['--profile', profile, 'app-server'];

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

    return {connection: connection, process: codex, ...(profile === undefined ? {} : {profile})};
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
