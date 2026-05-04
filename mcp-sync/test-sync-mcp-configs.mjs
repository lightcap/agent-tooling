#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(root, "sync-mcp-configs.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-sync-test-"));

try {
  testUserScopeSync();
  testLocalScopeSync();
  testCodexQuotedKeyCleanup();
  testClaudeAllowPruning();
  testClaudeAllowPruneWithoutTarget();
  testJsonTargetManagedServerPruning();
  testCodexTargetPathPruning();
  testCodexTargetRemovalPruning();
  testCodexExcludedSourcePreservesManualBlock();
  testJsonTargetPathPruning();
  testJsonTargetRemovalPruning();
  testClaudeScopeChangePruning();
  testProjectBackupDirectory();
  testUnknownFieldValidation();
  console.log("mcp-sync fixture tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function testUserScopeSync() {
  const fixture = path.join(tmp, "user-scope");
  fs.mkdirSync(fixture, { recursive: true });

  const backupDir = path.join(fixture, "backups");
  const claudePath = path.join(fixture, "claude.json");
  const claudeSettingsPath = path.join(fixture, "claude-settings.json");
  const codexPath = path.join(fixture, "codex.toml");
  const openCodePath = path.join(fixture, "opencode.json");
  const existingClaude = { mcpServers: { stale: { type: "stdio", command: "stale" } } };
  const existingClaudeSettings = { permissions: { allow: ["Bash(npm test)"] } };
  const existingCodex = 'model = "gpt-5.5"\n';
  const existingOpenCode = { $schema: "https://opencode.ai/config.json", share: "manual" };

  writeJson(claudePath, existingClaude);
  writeJson(claudeSettingsPath, existingClaudeSettings);
  fs.writeFileSync(codexPath, existingCodex);
  writeJson(openCodePath, existingOpenCode);

  runSync({
    backupDir,
    targets: {
      claude: {
        mcpConfigPath: claudePath,
        scope: "user",
        settingsPath: claudeSettingsPath,
      },
      codex: { configPath: codexPath },
      opencode: { configPath: openCodePath },
    },
    servers: {
      local: {
        type: "local",
        command: "node",
        args: ["server.mjs"],
        environment: { FOO: "bar" },
        codexApprovalTools: ["read_resource"],
      },
      remote: {
        type: "remote",
        url: "https://mcp.example.com/mcp",
        excludePlatforms: ["codex"],
        claude: { oauth: { scopes: "read" } },
        opencode: { oauth: { scope: "read" } },
      },
      codex_remote: {
        type: "remote",
        url: "https://codex.example.com/mcp",
        platforms: ["codex"],
        bearerTokenEnvVar: "CODEX_MCP_TOKEN",
        envHttpHeaders: { "X-API-Key": "CODEX_MCP_KEY" },
      },
    },
    claudeAllowTools: ["read_resource"],
  }, path.join(fixture, "servers.json"));

  assert.deepEqual(readJson(findBackup(backupDir, claudePath)), existingClaude);
  assert.deepEqual(readJson(findBackup(backupDir, claudeSettingsPath)), existingClaudeSettings);
  assert.equal(fs.readFileSync(findBackup(backupDir, codexPath), "utf8"), existingCodex);
  assert.deepEqual(readJson(findBackup(backupDir, openCodePath)), existingOpenCode);

  const claude = readJson(claudePath);
  assert.equal(claude.mcpServers.stale.command, "stale");
  assert.equal(claude.mcpServers.local.type, "stdio");
  assert.equal(claude.mcpServers.local.command, "node");
  assert.deepEqual(claude.mcpServers.local.args, ["server.mjs"]);
  assert.equal(claude.mcpServers.remote.type, "http");
  assert.equal(claude.mcpServers.remote.oauth.scopes, "read");
  assert.equal(claude.mcpServers.codex_remote, undefined);

  const claudeSettings = readJson(claudeSettingsPath);
  assert.deepEqual(claudeSettings.permissions.allow, [
    "Bash(npm test)",
    "mcp__local__read_resource",
    "mcp__remote__read_resource",
  ]);

  const codex = fs.readFileSync(codexPath, "utf8");
  assert.match(codex, /model = "gpt-5\.5"/);
  assert.match(codex, /\[mcp_servers\.local\]/);
  assert.match(codex, /command = "node"/);
  assert.match(codex, /\[mcp_servers\.codex_remote\]/);
  assert.match(codex, /bearer_token_env_var = "CODEX_MCP_TOKEN"/);
  assert.doesNotMatch(codex, /\[mcp_servers\.remote\]/);

  const opencode = readJson(openCodePath);
  assert.equal(opencode.share, "manual");
  assert.deepEqual(opencode.mcp.local.command, ["node", "server.mjs"]);
  assert.equal(opencode.mcp.remote.type, "remote");
  assert.equal(opencode.mcp.remote.oauth.scope, "read");
  assert.equal(opencode.mcp.codex_remote, undefined);
}

function testLocalScopeSync() {
  const fixture = path.join(tmp, "local-scope");
  const projectPath = path.join(fixture, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  const claudePath = path.join(fixture, "claude.json");

  runSync({
    backupDir: path.join(fixture, "backups"),
    targets: {
      claude: {
        mcpConfigPath: claudePath,
        scope: "local",
        projectPath,
      },
    },
    servers: {
      local: {
        type: "local",
        command: "node",
        args: ["local-server.mjs"],
      },
    },
  }, path.join(fixture, "servers.json"));

  assert.equal(findBackups(path.join(fixture, "backups"), claudePath).length, 0);
  const claude = readJson(claudePath);
  const projectKey = fs.realpathSync.native(projectPath);
  assert.equal(claude.projects[projectKey].mcpServers.local.type, "stdio");
  assert.equal(claude.projects[projectKey].mcpServers.local.command, "node");
}

function testCodexQuotedKeyCleanup() {
  const fixture = path.join(tmp, "codex-quoted-key");
  fs.mkdirSync(fixture, { recursive: true });
  const codexPath = path.join(fixture, "codex.toml");
  fs.writeFileSync(codexPath, '# existing\n\n[mcp_servers."github.com"] # prior generated entry\ncommand = "old"\nargs = []\n');

  runSync({
    backupDir: path.join(fixture, "backups"),
    targets: { codex: { configPath: codexPath } },
    servers: {
      "github.com": {
        type: "local",
        command: "node",
        args: ["new.mjs"],
      },
    },
  }, path.join(fixture, "servers.json"));

  const codex = fs.readFileSync(codexPath, "utf8");
  assert.equal([...codex.matchAll(/\[mcp_servers\."github\.com"\]/g)].length, 1);
  assert.doesNotMatch(codex, /command = "old"/);
  assert.match(codex, /command = "node"/);
}

function testClaudeAllowPruning() {
  const fixture = path.join(tmp, "claude-allow-pruning");
  fs.mkdirSync(fixture, { recursive: true });
  const backupDir = path.join(fixture, "backups");
  const sourcePath = path.join(fixture, "servers.json");
  const claudePath = path.join(fixture, "claude.json");
  const settingsPath = path.join(fixture, "settings.json");

  runSync({
    backupDir,
    targets: { claude: { mcpConfigPath: claudePath, scope: "user", settingsPath } },
    servers: { oldServer: { type: "local", command: "node", args: ["old.mjs"] } },
    claudeAllowTools: ["write_resource"],
  }, sourcePath);

  runSync({
    backupDir,
    targets: { claude: { mcpConfigPath: claudePath, scope: "user", settingsPath } },
    servers: { newServer: { type: "local", command: "node", args: ["new.mjs"] } },
    claudeAllowTools: ["read_resource"],
  }, sourcePath);

  const settings = readJson(settingsPath);
  assert.deepEqual(settings.permissions.allow, ["mcp__newServer__read_resource"]);
}

function testClaudeAllowPruneWithoutTarget() {
  const fixture = path.join(tmp, "claude-allow-prune-without-target");
  fs.mkdirSync(fixture, { recursive: true });
  const sourcePath = path.join(fixture, "servers.json");
  const settingsPath = path.join(fixture, "settings.json");

  runSync({
    backupDir: path.join(fixture, "backups"),
    targets: {
      claude: {
        mcpConfigPath: path.join(fixture, "claude.json"),
        scope: "user",
        settingsPath,
      },
    },
    servers: { managed: { type: "local", command: "node", args: ["server.mjs"] } },
    claudeAllowTools: ["write_resource"],
  }, sourcePath);

  runSync({
    backupDir: path.join(fixture, "backups"),
    targets: {},
    servers: {},
  }, sourcePath);

  assert.deepEqual(readJson(settingsPath).permissions.allow, []);
}

function testProjectBackupDirectory() {
  const fixture = path.join(tmp, "project-backup-dir");
  const projectPath = path.join(fixture, "project");
  const backupDir = path.join(fixture, "backups");
  fs.mkdirSync(projectPath, { recursive: true });
  const mcpPath = path.join(projectPath, ".mcp.json");
  writeJson(mcpPath, { mcpServers: { stale: { type: "stdio", command: "stale" } } });

  runSync({
    backupDir,
    targets: { claude: { mcpConfigPath: mcpPath, scope: "project" } },
    servers: { fresh: { type: "local", command: "node", args: ["fresh.mjs"] } },
  }, path.join(fixture, "servers.json"));

  assert.equal(fs.readdirSync(projectPath).some((entry) => entry.endsWith(".bak")), false);
  assert.deepEqual(readJson(findBackup(backupDir, mcpPath)), {
    mcpServers: { stale: { type: "stdio", command: "stale" } },
  });
}

function testJsonTargetManagedServerPruning() {
  const fixture = path.join(tmp, "json-managed-server-pruning");
  fs.mkdirSync(fixture, { recursive: true });
  const backupDir = path.join(fixture, "backups");
  const sourcePath = path.join(fixture, "servers.json");
  const claudePath = path.join(fixture, "claude.json");
  const openCodePath = path.join(fixture, "opencode.json");

  runSync({
    backupDir,
    targets: {
      claude: { mcpConfigPath: claudePath, scope: "user" },
      opencode: { configPath: openCodePath },
    },
    servers: { oldServer: { type: "local", command: "node", args: ["old.mjs"] } },
  }, sourcePath);

  runSync({
    backupDir,
    targets: {
      claude: { mcpConfigPath: claudePath, scope: "user" },
      opencode: { configPath: openCodePath },
    },
    servers: { newServer: { type: "local", command: "node", args: ["new.mjs"] } },
  }, sourcePath);

  const claude = readJson(claudePath);
  assert.equal(claude.mcpServers.oldServer, undefined);
  assert.equal(claude.mcpServers.newServer.command, "node");

  const opencode = readJson(openCodePath);
  assert.equal(opencode.mcp.oldServer, undefined);
  assert.deepEqual(opencode.mcp.newServer.command, ["node", "new.mjs"]);
}

function testCodexTargetPathPruning() {
  const fixture = path.join(tmp, "codex-target-path-pruning");
  fs.mkdirSync(fixture, { recursive: true });
  const backupDir = path.join(fixture, "backups");
  const sourcePath = path.join(fixture, "servers.json");
  const firstCodexPath = path.join(fixture, "codex-old.toml");
  const secondCodexPath = path.join(fixture, "codex-new.toml");

  runSync({
    backupDir,
    targets: { codex: { configPath: firstCodexPath } },
    servers: { managed: { type: "local", command: "node", args: ["old.mjs"] } },
  }, sourcePath);

  runSync({
    backupDir,
    targets: { codex: { configPath: secondCodexPath } },
    servers: { managed: { type: "local", command: "node", args: ["new.mjs"] } },
  }, sourcePath);

  const oldCodex = fs.readFileSync(firstCodexPath, "utf8");
  assert.doesNotMatch(oldCodex, /generated by agent-tooling/);
  assert.doesNotMatch(oldCodex, /mcp_servers/);

  const newCodex = fs.readFileSync(secondCodexPath, "utf8");
  assert.match(newCodex, /\[mcp_servers\.managed\]/);
  assert.match(newCodex, /new\.mjs/);
}

function testCodexTargetRemovalPruning() {
  const fixture = path.join(tmp, "codex-target-removal-pruning");
  fs.mkdirSync(fixture, { recursive: true });
  const backupDir = path.join(fixture, "backups");
  const sourcePath = path.join(fixture, "servers.json");
  const codexPath = path.join(fixture, "codex.toml");

  runSync({
    backupDir,
    targets: { codex: { configPath: codexPath } },
    servers: { managed: { type: "local", command: "node", args: ["server.mjs"] } },
  }, sourcePath);

  runSync({
    backupDir,
    targets: {},
    servers: {},
  }, sourcePath);

  const codex = fs.readFileSync(codexPath, "utf8");
  assert.doesNotMatch(codex, /generated by agent-tooling/);
  assert.doesNotMatch(codex, /mcp_servers/);
}

function testCodexExcludedSourcePreservesManualBlock() {
  const fixture = path.join(tmp, "codex-excluded-source-preserves-manual-block");
  fs.mkdirSync(fixture, { recursive: true });
  const codexPath = path.join(fixture, "codex.toml");
  fs.writeFileSync(codexPath, '[mcp_servers.manual]\ncommand = "manual"\nargs = []\n');

  runSync({
    backupDir: path.join(fixture, "backups"),
    targets: { codex: { configPath: codexPath } },
    servers: {
      manual: {
        type: "local",
        command: "node",
        args: ["managed.mjs"],
        excludePlatforms: ["codex"],
      },
    },
  }, path.join(fixture, "servers.json"));

  const codex = fs.readFileSync(codexPath, "utf8");
  assert.match(codex, /\[mcp_servers\.manual\]/);
  assert.match(codex, /command = "manual"/);
  assert.doesNotMatch(codex, /managed\.mjs/);
}

function testJsonTargetPathPruning() {
  const fixture = path.join(tmp, "json-target-path-pruning");
  fs.mkdirSync(fixture, { recursive: true });
  const backupDir = path.join(fixture, "backups");
  const sourcePath = path.join(fixture, "servers.json");
  const firstClaudePath = path.join(fixture, "claude-old.json");
  const secondClaudePath = path.join(fixture, "claude-new.json");
  const firstOpenCodePath = path.join(fixture, "opencode-old.json");
  const secondOpenCodePath = path.join(fixture, "opencode-new.json");

  runSync({
    backupDir,
    targets: {
      claude: { mcpConfigPath: firstClaudePath, scope: "user" },
      opencode: { configPath: firstOpenCodePath },
    },
    servers: { managed: { type: "local", command: "node", args: ["old.mjs"] } },
  }, sourcePath);

  runSync({
    backupDir,
    targets: {
      claude: { mcpConfigPath: secondClaudePath, scope: "user" },
      opencode: { configPath: secondOpenCodePath },
    },
    servers: { managed: { type: "local", command: "node", args: ["new.mjs"] } },
  }, sourcePath);

  assert.equal(readJson(firstClaudePath).mcpServers.managed, undefined);
  assert.equal(readJson(firstOpenCodePath).mcp.managed, undefined);
  assert.equal(readJson(secondClaudePath).mcpServers.managed.command, "node");
  assert.deepEqual(readJson(secondOpenCodePath).mcp.managed.command, ["node", "new.mjs"]);
}

function testJsonTargetRemovalPruning() {
  const fixture = path.join(tmp, "json-target-removal-pruning");
  fs.mkdirSync(fixture, { recursive: true });
  const backupDir = path.join(fixture, "backups");
  const sourcePath = path.join(fixture, "servers.json");
  const claudePath = path.join(fixture, "claude.json");
  const openCodePath = path.join(fixture, "opencode.json");

  runSync({
    backupDir,
    targets: {
      claude: { mcpConfigPath: claudePath, scope: "user" },
      opencode: { configPath: openCodePath },
    },
    servers: { managed: { type: "local", command: "node", args: ["server.mjs"] } },
  }, sourcePath);

  runSync({
    backupDir,
    targets: {},
    servers: {},
  }, sourcePath);

  assert.equal(readJson(claudePath).mcpServers.managed, undefined);
  assert.equal(readJson(openCodePath).mcp.managed, undefined);
}

function testClaudeScopeChangePruning() {
  const fixture = path.join(tmp, "claude-scope-change-pruning");
  const projectPath = path.join(fixture, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  const backupDir = path.join(fixture, "backups");
  const sourcePath = path.join(fixture, "servers.json");
  const claudePath = path.join(fixture, "claude.json");

  runSync({
    backupDir,
    targets: { claude: { mcpConfigPath: claudePath, scope: "user" } },
    servers: { managed: { type: "local", command: "node", args: ["user.mjs"] } },
  }, sourcePath);

  runSync({
    backupDir,
    targets: { claude: { mcpConfigPath: claudePath, scope: "local", projectPath } },
    servers: { managed: { type: "local", command: "node", args: ["local.mjs"] } },
  }, sourcePath);

  const claude = readJson(claudePath);
  const projectKey = fs.realpathSync.native(projectPath);
  assert.equal(claude.mcpServers.managed, undefined);
  assert.deepEqual(claude.projects[projectKey].mcpServers.managed.args, ["local.mjs"]);
}

function testUnknownFieldValidation() {
  const fixture = path.join(tmp, "unknown-field-validation");
  fs.mkdirSync(fixture, { recursive: true });
  const codexPath = path.join(fixture, "codex.toml");

  const sourceResult = runSyncFailure({
    targets: {},
    servers: {},
    typo: true,
  }, path.join(fixture, "source.json"));
  assert.match(sourceResult.stderr, /source\.json: unknown property typo/);

  const targetResult = runSyncFailure({
    targets: { codex: { configPath: codexPath, typo: true } },
    servers: {},
  }, path.join(fixture, "target.json"));
  assert.match(targetResult.stderr, /targets\.codex: unknown property typo/);

  const serverResult = runSyncFailure({
    targets: { codex: { configPath: codexPath } },
    servers: {
      bad: {
        type: "local",
        command: "node",
        argz: ["server.mjs"],
      },
    },
  }, path.join(fixture, "server.json"));
  assert.match(serverResult.stderr, /servers\.bad: unknown property argz/);

  const overrideResult = runSyncFailure({
    targets: { codex: { configPath: codexPath } },
    servers: {
      bad: {
        type: "local",
        command: "node",
        codex: { argz: ["server.mjs"] },
      },
    },
  }, path.join(fixture, "override.json"));
  assert.match(overrideResult.stderr, /servers\.bad\.codex: unknown property argz/);

  assert.equal(fs.existsSync(codexPath), false);
}

function runSync(source, sourcePath) {
  fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  const result = spawnSync(process.execPath, [scriptPath, "--source", sourcePath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runSyncFailure(source, sourcePath) {
  fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  const result = spawnSync(process.execPath, [scriptPath, "--source", sourcePath], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, result.stdout);
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function findBackup(backupDir, filePath) {
  const backups = findBackups(backupDir, filePath);
  assert.equal(backups.length, 1, `Expected one backup for ${filePath}, found ${backups.length}`);
  return backups[0];
}

function findBackups(backupDir, filePath) {
  const backupPath = backupPathForTarget(backupDir, filePath);
  const dir = path.dirname(backupPath);
  if (!fs.existsSync(dir)) return [];
  const name = path.basename(backupPath);
  return fs.readdirSync(dir).filter((entry) => entry === name || entry.match(new RegExp(`^${escapeRegExp(name)}\\.\\d+$`))).map((entry) => path.join(dir, entry));
}

function backupPathForTarget(backupDir, filePath) {
  const resolved = path.resolve(filePath);
  const parsed = path.parse(resolved);
  return path.join(backupDir, resolved.slice(parsed.root.length).replace(/:/g, ""));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
