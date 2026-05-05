# MCP Sync

Single source of truth for MCP server definitions used by Claude Code, Codex, and OpenCode.

## Files

- `servers.example.json` is a template for your local MCP servers.
- `servers.json` defines MCP servers once and is intentionally ignored by git.
- `sync-mcp-configs.mjs` renders client-specific config formats.
- `test-sync-mcp-configs.mjs` runs fixture checks without touching live configs.
- `servers.schema.json` documents and validates the source config shape in editors.

Create your local config first:

```bash
cp servers.example.json servers.json
```

Then edit `servers.json` for your local paths and server names.

## Usage

```bash
node ~/projects/agent-tooling/mcp-sync/sync-mcp-configs.mjs
```

Use a different source file when testing or keeping multiple profiles:

```bash
node ~/projects/agent-tooling/mcp-sync/sync-mcp-configs.mjs --source ./servers.work.json
```

Each source file is authoritative for the target files it configures. If multiple profiles write to the same Codex config, they replace this tool's generated Codex block rather than merging generated blocks from each profile.

Use a custom backup directory:

```bash
node ~/projects/agent-tooling/mcp-sync/sync-mcp-configs.mjs --backup-dir ~/.local/state/agent-tooling/mcp-sync/backups/manual
```

The script updates:

- `~/.claude.json` for Claude user/local MCP servers, or `.mcp.json` for Claude project MCP servers
- `~/.claude/settings.json` for optional Claude MCP tool allow-list entries
- `~/.codex/config.toml`
- `~/.config/opencode/opencode.json`

Restart each agent session after syncing so the client reloads MCP tools.

Before overwriting an existing target config, the script copies it into a timestamped backup directory under `~/.local/state/agent-tooling/mcp-sync/backups/`, or into `backupDir` / `--backup-dir` when configured. New target files are created without backups.

The script also writes a local `*.state.json` file next to the source config. This tracks generated JSON-target servers, Codex target paths, and Claude MCP permission entries so stale entries can be pruned on later syncs.

## Verification

```bash
node mcp-sync/test-sync-mcp-configs.mjs
```

## Source Format

Each server entry starts with a common definition:

```json
{
  "type": "local",
  "command": "npx",
  "args": ["-y", "@example/mcp-server"],
  "enabled": true
}
```

Local servers render to Claude/Codex stdio config and OpenCode `type: "local"` config. Add `environment` for process environment variables.

Remote servers use `type: "remote"` and `url`:

```json
{
  "type": "remote",
  "url": "https://mcp.example.com/mcp"
}
```

Remote rendering differs by client: Claude uses `type: "http"` or `"sse"`, Codex uses `url`, and OpenCode uses `type: "remote"`. Use `transport` to choose Claude's remote transport; it defaults to `http`.

Use `platforms` or `excludePlatforms` to control where a server appears:

```json
{
  "type": "remote",
  "url": "https://mcp.example.com/mcp",
  "excludePlatforms": ["codex"]
}
```

Here `claude` means Claude Code's local MCP config, not Claude.ai account connectors. If Claude.ai already provides a native connector, leave Claude Code out and sync only the other clients:

```json
{
  "type": "remote",
  "url": "https://mcp.linear.app/mcp",
  "excludePlatforms": ["claude"]
}
```

Use `claude`, `codex`, and `opencode` for client-specific overrides, or set one to `false` to disable that server for that client:

```json
{
  "type": "remote",
  "url": "https://mcp.example.com/mcp",
  "claude": {"oauth": {"scopes": "resources:read"}},
  "opencode": {"oauth": {"scope": "resources:read"}},
  "codex": false
}
```

Codex-specific remote auth helpers:

- `bearerTokenEnvVar` renders `bearer_token_env_var`.
- `envHttpHeaders` renders `env_http_headers`.
- `scopes` renders OAuth scopes.

Paths in target config and `--source` support `~` expansion.

Set top-level `backupDir` or pass `--backup-dir` to choose where backups are written.

Claude target fields:

- `mcpConfigPath` points at `~/.claude.json` for `user` or `local` scope, or `.mcp.json` for `project` scope.
- `scope` can be `user`, `local`, or `project`; it defaults to `user`.
- `projectPath` is only needed for Claude `local` scope when you want to write the per-project entry for a project other than the current working directory.
- `settingsPath` is optional and is only used for `claudeAllowTools` permission entries.
