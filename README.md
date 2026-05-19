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
- `claude` means Claude Code's local MCP config, not Claude.ai account connectors. Use `excludePlatforms: ["claude"]` when Claude.ai already provides the server.
- Claude MCP targets use `mcpConfigPath` for `~/.claude.json` or `.mcp.json`; `settingsPath` is only for optional permissions allow-list updates.
- Target paths and source paths support `~` expansion.
- A local `*.state.json` file tracks generated JSON-target servers, Codex target paths, and Claude MCP permission entries so stale entries can be pruned on later syncs.

## Skill Sync

Skills (SKILL.md files) are managed differently per platform:

- **Claude Code** loads skills via the plugin system (marketplace plugins at `~/.claude/plugins/`). Personal skills can also go in `~/.claude/skills/`, but avoid duplicating what a plugin already provides.
- **Codex, OpenCode, OpenClaw** load skills from their respective directories (`~/.codex/skills/`, `~/.config/opencode/skills/`, `~/.openclaw/skills/`).

[skillshare](https://github.com/runkids/skillshare) syncs a single source directory to all non-Claude targets:

```bash
brew install skillshare
skillshare init
```

Configuration lives at `~/.config/skillshare/config.yaml`. Point `source:` at your skills repo's skills directory, then add targets:

```bash
skillshare target add codex ~/.codex/skills
skillshare target add opencode ~/.config/opencode/skills
skillshare target add openclaw ~/.openclaw/skills
```

Set Codex to copy mode so skills survive system updates that rebuild `~/.codex/skills/`:

```bash
skillshare target codex --mode copy
```

Sync after editing skills or after a platform update wipes a target directory:

```bash
skillshare sync
```

### Why not use skillshare for Claude Code too?

Claude Code's plugin system bundles skills with agents, hooks, and MCP servers. Most of the Claude Code ecosystem distributes via plugins/marketplaces, not raw SKILL.md files. Using the plugin for Claude Code and skillshare for everything else avoids duplicates and keeps each platform using its native distribution mechanism.

### Why copy mode for Codex?

Codex periodically rebuilds `~/.codex/skills/` during system skill updates, which deletes all user-installed skills. Copy mode means `skillshare sync` restores them. Symlink mode (the default for other targets) would leave dangling links after a rebuild.

## License

MIT
