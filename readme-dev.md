This package uses the bundled `@openai/codex` dependency by default.
Set `CODEX_PATH` to run a different Codex binary; versions other than the one specified in `package.json` may not be compatible.

### Runtime environment

- `CODEX_API_KEY` - API key used when the API-key auth method is selected. Takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` - fallback API key used when the API-key auth method is selected.
- `CODEX_PATH` - run a specific Codex executable instead of the bundled package dependency.
- `CODEX_CONFIG` - JSON object merged into the Codex session config. `hooks` move to App Server startup (`-c hooks=...`) for AIR review; Codex rejects malformed hooks at startup and `initialize` reports its error.
- `CODEX_PROFILE` - optional plain profile name (`A-Z`, `a-z`, digits, `_`, `-`), passed as `--profile NAME` at app-server startup. Requires a Codex runtime supporting profiles for standalone app-server; unsupported runtimes fail without fallback. The selection lasts for the process lifetime and cannot be selected through `CODEX_CONFIG` or ACP session metadata. With this option, MCP servers supplied by the client are added alongside `CODEX_CONFIG` servers; collisions with effective/layered configuration or another supplied name (after whitespace normalization) reject the session. `DISABLE_MCP_CONFIG_FILTERING` cannot bypass this check. Without this option, existing filtering behavior is unchanged.
- `CODEX_APP_SERVER_CONFIG` - opt-in JSON array of native startup `key=value` overrides; see the protected startup contract below.
- `MODEL_PROVIDER` - model provider to pass to Codex for new sessions.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `workspace-write`, `agent`, or `agent-full-access`.
- `NO_BROWSER` - hide browser-based ChatGPT auth when set.
- `APP_SERVER_LOGS` - directory for adapter logs.
- `CODEX_ACP_APP_SERVER_CRASH_LIMIT` - how many crashes of the Codex app-server in the crash window stop its automatic restart (default `5`).
- `CODEX_ACP_APP_SERVER_CRASH_WINDOW_MS` - the crash window in milliseconds (default `300000`, 5 minutes).

### Protected native startup (CRA-955)

Fork version `2.0.0-cra955.1` adds a transport-neutral trusted-launcher seam:

```json
{
  "CODEX_PATH": "/absolute/path/to/codex",
  "CODEX_PROFILE": "work",
  "CODEX_APP_SERVER_CONFIG": "[\"model_provider=\\\"private\\\"\",\"model_providers.private.base_url=\\\"http://localhost:1234/v1\\\"\"]"
}
```

When present (even if empty), the knob requires a valid selected `CODEX_PROFILE`
and an explicit absolute `CODEX_PATH` matching the executable passed to startup.
`CODEX_CONFIG` and `MODEL_PROVIDER` must be absent, not merely empty. Windows is
rejected before spawning: protected arguments never use its legacy shell seam.
On supported platforms startup is direct argv:
`CODEX_PATH --profile NAME -c KEY=VALUE [-c KEY=VALUE ...] app-server`.
Spaces and quotes remain in one argument; no shell interpolation or arbitrary
native flags are accepted. The executable must support these native options.

The JSON must contain 1–64 strings, at most 65,536 UTF-8 bytes total and 8,192
UTF-8 bytes per string. Each string is `key=value`, with a nonempty value and
bare dotted key segments containing only ASCII letters, digits, `_`, or `-`;
the key cannot start with `-` (flag-like arguments are rejected).
Whitespace around keys, quoted keys, and C0/C1 control characters (including
newlines, tabs, NUL, and DEL) are rejected. Values are forwarded unchanged;
validation is structural, not a TOML parser. Native Codex owns TOML/value
interpretation and precedence, including its string fallback behavior.

The protected startup environment is copied without mutating the caller or
`process.env` and retained for app-server recreation/provider restarts. The
selected-profile MCP merge/collision behavior is unchanged. When the knob is
absent, existing startup behavior is unchanged (including the Windows path).

This is startup forwarding for a trusted launcher, **not** authentication, a
sandbox, or a guarantee against later ACP session/provider overrides. It does
not attest the executable, hide argv/environment secrets, replace native
configuration validation, or configure any particular proxy/transport. No
native runtime compatibility or end-to-end routing is established by unit tests.

### Quick start

#### Develop on Windows?

- Download and install [C++ redistributable package](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170#latest-supported-redistributable-version)

#### Adjust ACP client config

Run from sources

1. Install dependencies `npm install`
2. Adjust ACP client config

```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "npm",
      "args": ["run", "start", "--prefix", "/path/to/project/"],
      "env": {
        "CODEX_PATH": "node_modules/.bin/codex",
        "APP_SERVER_LOGS": "optional/path/to/existing/log/directory"
      }
    }
  }
}
```

Run from binaries

1. Download a `codex-acp-<platform>.zip` archive from https://github.com/agentclientprotocol/codex-acp/releases (`<platform>` is one of: `linux`, `darwin`, `win32`)
2. Unzip the archive:
   ```bash
   unzip codex-acp-<platform>.zip
   ```
3. Adjust ACP client config

```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "/path/to/codex-acp",
      "env": {
        "CODEX_PATH": "/path/to/codex"
      }
    }
  }
}
```

### Build binaries

Building standalone binaries requires [bun](https://bun.com/docs/installation).

Build single-file executables in `dist/bin` directory:

```bash
npm run bundle:all
```

Package binaries into zip archives:

```bash
npm run package:all
```

### Update supported Codex version

1. Update the `@openai/codex` version in `package.json` (under `dependencies`).
2. Regenerate Codex types in `src/app-server/`: `npm run generate-types`
3. Ensure there are no type errors or failed tests: `npm run typecheck` and `npm run test`

### Session notices

The adapter implements [Session Notices](https://agentclientprotocol.com/rfds/session-notices)
for Codex warnings, configuration warnings, deprecation notices, model rerouting, and the legacy
`thread/compacted` advisory when the client advertises `clientCapabilities.session.notices: {}`.
These are live `session/update` notifications with
`sessionUpdate: "notice"`, a severity, a plain-text title, and optional description.
They are not replayed from session history and repeated notices remain independent events.

Without that capability (including absent or null capability objects), the adapter preserves
the existing assistant/thought text or AIR `sessionFailure` advisory records. When notices are
enabled, they take precedence over AIR advisory records. Clients control their presentation;
the adapter does not rely on notices being displayed.

Command replies, review results, and terminal/retrying errors retain their existing response or
failure channels. Clients advertising session compaction support continue to receive the dedicated
compaction lifecycle instead of the legacy completion advisory.


### App-server recovery

The adapter restarts the Codex app-server when it dies (for example, killed for lack of memory). Its code is in
`src/app-server-recovery/`.

- A request that was waiting on the dead app-server fails with error `1001` and the cause, such as "was killed by
  SIGKILL, which usually means it ran out of memory". A running prompt ends at once: open tool calls become `failed`,
  open permission dialogs are cancelled, and an AIR client gets the `transport_lost` session failure.
- An app-server that exits before its `initialize` handshake succeeded, such as one that rejects its startup config,
  fails the request with "Codex process has exited with code N:" and its stderr, and no promise of a restart.
- The next request starts a new app-server with the same `initialize` handshake and provider routing. A session that
  was open is resumed on its next use, with the model, mode and settings that the adapter kept.
- Codex writes a thread to disk only with its first message, so a session without messages cannot be resumed in a new
  app-server, after a crash or a provider restart. Its next use fails with "had no messages yet and was lost"; the
  client starts a new session. A provider restart still completes for the agent and the other sessions.
- After `CODEX_ACP_APP_SERVER_CRASH_LIMIT` crashes in the crash window the adapter stops restarting it and says so,
  with the stderr of the last crash.
  A session that the app-server died opening twice in 30 minutes is not opened again for the rest of that time, so
  one session that is too large for the memory cannot take the other sessions down with it.
