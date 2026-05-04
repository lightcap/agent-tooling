# Agent Tooling

Local tooling for keeping agent/client configuration consistent across Claude Code, Codex, and OpenCode.

## MCP Sync

The MCP sync utility keeps MCP server definitions in one source file and renders each client-specific config format. It supports local stdio servers, remote HTTP/SSE servers where each client supports them, per-platform include/exclude rules, and platform-specific overrides for auth differences.

Canonical files live in `mcp-sync/`:

- `mcp-sync/servers.example.json` is a template for your local MCP servers.
- `mcp-sync/servers.json` defines MCP servers once and is intentionally ignored by git.
- `mcp-sync/sync-mcp-configs.mjs` updates Claude, Codex, and OpenCode configs.
- `mcp-sync/test-sync-mcp-configs.mjs` runs fixture checks without touching live configs.
- `mcp-sync/servers.schema.json` documents the source format.

Set up your local config:

```bash
cp mcp-sync/servers.example.json mcp-sync/servers.json
```

Then edit `mcp-sync/servers.json` for your local paths and MCP server names.

Run it with:

```bash
node ~/projects/agent-tooling/mcp-sync/sync-mcp-configs.mjs
```

Or point it at another source or backup directory:

```bash
node ~/projects/agent-tooling/mcp-sync/sync-mcp-configs.mjs --source ./servers.json
node ~/projects/agent-tooling/mcp-sync/sync-mcp-configs.mjs --backup-dir ~/.local/state/agent-tooling/mcp-sync/backups/manual
```

Each source file is authoritative for the target files it configures. Multiple profiles targeting the same Codex config replace this tool's generated Codex block rather than merging generated blocks from each profile.

Restart already-running agent sessions after syncing so they reload MCP tools.

Before overwriting an existing target config, the sync utility copies it into a timestamped backup directory under `~/.local/state/agent-tooling/mcp-sync/backups/`, or into `backupDir` / `--backup-dir` when configured. New target files are created without backups.

Run fixture checks with:

```bash
node mcp-sync/test-sync-mcp-configs.mjs
```

Useful source fields:

- `type: "local"` uses `command`, `args`, and optional `environment`.
- `type: "remote"` uses `url`, optional `headers`, and platform-specific OAuth config.
- `platforms` includes a server only for listed clients.
- `excludePlatforms` omits a server from listed clients.
- `claude`, `codex`, and `opencode` override fields for one client, or `false` disables that server for that client.
- Claude MCP targets use `mcpConfigPath` for `~/.claude.json` or `.mcp.json`; `settingsPath` is only for optional permissions allow-list updates.
- Target paths and source paths support `~` expansion.
- A local `*.state.json` file tracks generated JSON-target servers, Codex target paths, and Claude MCP permission entries so stale entries can be pruned on later syncs.

## License

MIT
