#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const platforms = ["claude", "codex", "opencode"];
const commonServerKeys = [
  "type",
  "command",
  "args",
  "url",
  "transport",
  "enabled",
  "environment",
  "headers",
  "headersHelper",
  "oauth",
  "timeout",
  "alwaysLoad",
  "cwd",
  "required",
  "startupTimeoutMs",
  "startupTimeoutSec",
  "toolTimeoutSec",
  "enabledTools",
  "disabledTools",
  "codexApprovalTools",
  "bearerTokenEnvVar",
  "oauthResource",
  "scopes",
  "envHttpHeaders",
];
const sourceKeys = new Set(["$schema", "backupDir", "targets", "servers", "claudeAllowTools"]);
const targetKeysByPlatform = {
  claude: new Set(["mcpConfigPath", "scope", "settingsPath", "projectPath"]),
  codex: new Set(["configPath"]),
  opencode: new Set(["configPath"]),
};
const serverKeys = new Set([...commonServerKeys, "platforms", "excludePlatforms", ...platforms]);
const platformOverrideKeys = new Set(commonServerKeys);
const root = path.dirname(fileURLToPath(import.meta.url));
const defaultSourcePath = path.join(root, "servers.json");
const examplePath = path.join(root, "servers.example.json");
const cli = parseArgs(process.argv.slice(2));
const { sourcePath } = cli;
const backedUpPaths = new Set();
const backupPaths = [];

if (!fs.existsSync(sourcePath)) {
  throw new Error(
    `Missing ${sourcePath}. Copy ${examplePath} to servers.json and customize it for this machine.`,
  );
}

const source = readJson(sourcePath, null);
validateSource(source, sourcePath);
const statePath = statePathForSource(sourcePath);
const state = readJson(statePath, {});
if (!isObject(state)) throw new Error(`${statePath}: state must be an object`);
const backupDir = resolveConfigPath(
  cli.backupDir ?? source.backupDir ?? process.env.MCP_SYNC_BACKUP_DIR ?? defaultBackupDir(),
);
let stateChanged = false;

const servers = source.servers ?? {};
const serverNames = Object.keys(servers);
const claudeServers = serversForPlatform(servers, "claude");
const codexServers = serversForPlatform(servers, "codex");
const openCodeServers = serversForPlatform(servers, "opencode");

stateChanged = syncClaude(source.targets?.claude, claudeServers, source.claudeAllowTools ?? [], state) || stateChanged;
stateChanged = syncCodex(source.targets?.codex, codexServers, state) || stateChanged;
stateChanged = syncOpenCode(source.targets?.opencode, openCodeServers, state) || stateChanged;

if (stateChanged) writeJson(statePath, state);

console.log(
  `Synced ${serverNames.length} MCP server(s): ` +
    `${Object.keys(claudeServers).length} Claude, ` +
    `${Object.keys(codexServers).length} Codex, ` +
    `${Object.keys(openCodeServers).length} OpenCode.`,
);
if (backupPaths.length > 0) console.log(`Backed up ${backupPaths.length} file(s) to ${backupDir}.`);

function syncClaude(target, servers, allowTools, state) {
  const mcpStateChanged = syncClaudeMcpServers(target, servers, state);
  const allowStateChanged = syncClaudeAllowTools(target ?? {}, servers, allowTools, state);
  return mcpStateChanged || allowStateChanged;
}

function syncClaudeMcpServers(target, servers, state) {
  const previous = isObject(state.claudeMcpServers) ? state.claudeMcpServers : {};
  const previousNames = new Set(stringArray(previous.names));
  const currentNames = Object.keys(servers);
  const current = target?.mcpConfigPath ? claudeTargetState(target) : undefined;

  if (previous.mcpConfigPath && !sameClaudeTarget(previous, current)) {
    removeClaudeMcpServers(previous, previousNames);
  }

  if (current) {
    const mcpConfig = readJson(current.mcpConfigPath, {});
    const mcpServers = claudeMcpServersForTargetState(mcpConfig, current);

    for (const name of previousNames) delete mcpServers[name];
    for (const name of currentNames) delete mcpServers[name];
    for (const [name, server] of Object.entries(servers)) {
      mcpServers[name] = renderClaudeServer(server);
    }

    if (currentNames.length > 0 || previousNames.size > 0) writeJson(current.mcpConfigPath, mcpConfig);
  }

  const nextState = current && currentNames.length > 0
    ? { ...current, names: currentNames }
    : undefined;

  if (JSON.stringify(previous) === JSON.stringify(nextState ?? {})) return false;

  if (nextState) state.claudeMcpServers = nextState;
  else delete state.claudeMcpServers;
  return true;
}

function removeClaudeMcpServers(target, names) {
  if (names.size === 0 || !fs.existsSync(target.mcpConfigPath)) return;

  const mcpConfig = readJson(target.mcpConfigPath, {});
  const mcpServers = claudeMcpServersForTargetState(mcpConfig, target);
  for (const name of names) delete mcpServers[name];
  writeJson(target.mcpConfigPath, mcpConfig);
}

function claudeTargetState(target) {
  const scope = target.scope ?? "user";
  return compactObject({
    mcpConfigPath: resolveConfigPath(target.mcpConfigPath),
    scope,
    projectPath: scope === "local" ? resolveClaudeProjectPath(target.projectPath) : undefined,
  });
}

function sameClaudeTarget(previous, current) {
  if (!current) return false;
  return previous.mcpConfigPath === current.mcpConfigPath &&
    (previous.scope ?? "user") === current.scope &&
    previous.projectPath === current.projectPath;
}

function claudeMcpServersForTargetState(config, target) {
  if ((target.scope ?? "user") !== "local") {
    config.mcpServers ??= {};
    return config.mcpServers;
  }

  config.projects ??= {};
  config.projects[target.projectPath] ??= {};
  config.projects[target.projectPath].mcpServers ??= {};
  return config.projects[target.projectPath].mcpServers;
}

function syncClaudeAllowTools(target, servers, allowTools, state) {
  const previous = isObject(state.claudeAllowTools) ? state.claudeAllowTools : {};
  const previousEntries = new Set(stringArray(previous.entries));
  const previousSettingsPath = typeof previous.settingsPath === "string" ? previous.settingsPath : undefined;
  const currentSettingsPath = target.settingsPath ? resolveConfigPath(target.settingsPath) : undefined;
  const currentEntries = target.settingsPath
    ? Object.keys(servers).flatMap((serverName) => allowTools.map((tool) => `mcp__${serverName}__${tool}`))
    : [];

  const changesByPath = new Map();
  addClaudeAllowChange(changesByPath, previousSettingsPath, "remove", previousEntries);
  addClaudeAllowChange(changesByPath, currentSettingsPath, "add", new Set(currentEntries));

  for (const [settingsPath, changes] of changesByPath) {
    updateClaudeAllowFile(settingsPath, changes.remove, changes.add);
  }

  const nextState = currentSettingsPath && currentEntries.length > 0
    ? { settingsPath: currentSettingsPath, entries: currentEntries }
    : undefined;

  if (JSON.stringify(previous) === JSON.stringify(nextState ?? {})) return false;

  if (nextState) state.claudeAllowTools = nextState;
  else delete state.claudeAllowTools;
  return true;
}

function addClaudeAllowChange(changesByPath, settingsPath, action, entries) {
  if (!settingsPath || entries.size === 0) return;
  changesByPath.set(settingsPath, changesByPath.get(settingsPath) ?? { add: new Set(), remove: new Set() });
  for (const entry of entries) changesByPath.get(settingsPath)[action].add(entry);
}

function updateClaudeAllowFile(settingsPath, removeEntries, addEntries) {
  if (!fs.existsSync(settingsPath) && addEntries.size === 0) return;

  const settings = readJson(settingsPath, {});
  if (settings.permissions === undefined) settings.permissions = {};
  if (!isObject(settings.permissions)) throw new Error(`${settingsPath}: permissions must be an object`);
  if (settings.permissions.allow === undefined) settings.permissions.allow = [];
  if (!Array.isArray(settings.permissions.allow)) {
    throw new Error(`${settingsPath}: permissions.allow must be an array`);
  }

  const allow = settings.permissions.allow.filter((entry) => !removeEntries.has(entry));
  const allowSet = new Set(allow);
  for (const entry of addEntries) allowSet.add(entry);

  settings.permissions.allow = Array.from(allowSet);
  writeJson(settingsPath, settings);
}

function syncCodex(target, servers, state) {
  const previous = isObject(state.codexMcpServers) ? state.codexMcpServers : {};
  const previousNames = new Set(stringArray(previous.names));
  const currentNames = Object.keys(servers);
  const currentConfigPath = target?.configPath ? resolveConfigPath(target.configPath) : undefined;

  if (previous.configPath && previous.configPath !== currentConfigPath) {
    removeCodexMcpServers(previous.configPath, previousNames);
  }

  if (currentConfigPath) {
    const existing = fs.existsSync(currentConfigPath)
      ? fs.readFileSync(currentConfigPath, "utf8")
      : "";
    const cleanupNames = new Set([...currentNames, ...previousNames]);
    const filtered = removeCodexManagedBlocks(existing, cleanupNames).trimEnd();
    const generated = currentNames.length > 0 ? renderCodexServers(servers) : "";
    const next = [filtered, generated].filter(Boolean).join("\n\n");

    fs.mkdirSync(path.dirname(currentConfigPath), { recursive: true });
    writeText(currentConfigPath, next ? `${next}\n` : "");
  }

  const nextState = currentConfigPath && currentNames.length > 0
    ? { configPath: currentConfigPath, names: currentNames }
    : undefined;

  if (JSON.stringify(previous) === JSON.stringify(nextState ?? {})) return false;

  if (nextState) state.codexMcpServers = nextState;
  else delete state.codexMcpServers;
  return true;
}

function removeCodexMcpServers(configPath, names) {
  if (!fs.existsSync(configPath)) return;

  const existing = fs.readFileSync(configPath, "utf8");
  const filtered = removeCodexManagedBlocks(existing, names);
  if (filtered === existing) return;

  const next = filtered.trimEnd();
  writeText(configPath, next ? `${next}\n` : "");
}

function syncOpenCode(target, servers, state) {
  const previous = isObject(state.openCodeMcpServers) ? state.openCodeMcpServers : {};
  const previousNames = new Set(stringArray(previous.names));
  const currentNames = Object.keys(servers);
  const currentConfigPath = target?.configPath ? resolveConfigPath(target.configPath) : undefined;

  if (previous.configPath && previous.configPath !== currentConfigPath) {
    removeOpenCodeMcpServers(previous.configPath, previousNames);
  }

  if (currentConfigPath) {
    const config = readJson(currentConfigPath, { $schema: "https://opencode.ai/config.json" });
    config.$schema ??= "https://opencode.ai/config.json";
    config.mcp ??= {};

    for (const name of previousNames) delete config.mcp[name];
    for (const name of currentNames) delete config.mcp[name];
    for (const [name, server] of Object.entries(servers)) {
      config.mcp[name] = renderOpenCodeServer(server);
    }

    if (currentNames.length > 0 || previousNames.size > 0) writeJson(currentConfigPath, config);
  }

  const nextState = currentConfigPath && currentNames.length > 0
    ? { configPath: currentConfigPath, names: currentNames }
    : undefined;

  if (JSON.stringify(previous) === JSON.stringify(nextState ?? {})) return false;

  if (nextState) state.openCodeMcpServers = nextState;
  else delete state.openCodeMcpServers;
  return true;
}

function removeOpenCodeMcpServers(configPath, names) {
  if (names.size === 0 || !fs.existsSync(configPath)) return;

  const config = readJson(configPath, { $schema: "https://opencode.ai/config.json" });
  config.$schema ??= "https://opencode.ai/config.json";
  config.mcp ??= {};

  for (const name of names) delete config.mcp[name];
  writeJson(configPath, config);
}

function removeCodexManagedBlocks(toml, serverNames) {
  const markerPattern = /\n?# BEGIN generated by (?:~\/\.config\/mcp-sync\/sync-mcp-configs\.mjs|agent-tooling\/mcp-sync)[\s\S]*?# END generated by (?:~\/\.config\/mcp-sync\/sync-mcp-configs\.mjs|agent-tooling\/mcp-sync)\n?/g;
  toml = toml.replace(markerPattern, "\n");

  const names = new Set(serverNames);
  const lines = toml.split(/\r?\n/);
  const blocks = [];
  let current = [];

  for (const line of lines) {
    if (parseTomlTableHeader(line) && current.length > 0) {
      blocks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);

  return blocks
    .filter((block) => {
      const header = block.find((line) => parseTomlTableHeader(line));
      if (!header) return true;
      const segments = parseTomlTableHeader(header);
      return segments?.[0] !== "mcp_servers" || !names.has(segments[1]);
    })
    .map((block) => block.join("\n"))
    .join("\n");
}

function renderCodexServers(servers) {
  const lines = ["# BEGIN generated by agent-tooling/mcp-sync"];

  for (const [name, server] of Object.entries(servers)) {
    lines.push(`\n[mcp_servers.${tomlBareKey(name)}]`);
    if (server.type === "remote") {
      renderCodexRemoteServer(lines, server);
    } else {
      renderCodexLocalServer(lines, server);
    }

    renderCodexCommonServerOptions(lines, server);

    for (const tool of server.codexApprovalTools ?? []) {
      lines.push(`\n[mcp_servers.${tomlBareKey(name)}.tools.${tomlBareKey(tool)}]`);
      lines.push('approval_mode = "approve"');
    }
  }

  lines.push("\n# END generated by agent-tooling/mcp-sync");
  return lines.join("\n");
}

function renderClaudeServer(server) {
  if (server.type === "remote") {
    return compactObject({
      type: server.transport ?? "http",
      url: server.url,
      headers: server.headers,
      headersHelper: server.headersHelper,
      oauth: isObject(server.oauth) ? server.oauth : undefined,
      disabled: server.enabled === false ? true : undefined,
      alwaysLoad: server.alwaysLoad,
    });
  }

  return compactObject({
    type: "stdio",
    command: server.command,
    args: server.args,
    env: server.environment,
    disabled: server.enabled === false ? true : undefined,
    alwaysLoad: server.alwaysLoad,
  });
}

function resolveClaudeProjectPath(projectPath) {
  const resolved = resolveConfigPath(projectPath ?? process.cwd());
  return fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
}

function renderOpenCodeServer(server) {
  if (server.type === "remote") {
    return compactObject({
      type: "remote",
      url: server.url,
      enabled: server.enabled ?? true,
      headers: server.headers,
      oauth: server.oauth,
      timeout: server.timeout,
    });
  }

  return compactObject({
    type: "local",
    command: [server.command, ...(server.args ?? [])],
    enabled: server.enabled ?? true,
    environment: server.environment,
    timeout: server.timeout,
  });
}

function renderCodexLocalServer(lines, server) {
  lines.push(`command = ${tomlString(server.command)}`);
  lines.push(`args = ${tomlArray(server.args ?? [])}`);
  appendTomlValue(lines, "cwd", server.cwd);

  for (const [key, value] of Object.entries(server.environment ?? {})) {
    lines.push(`env.${tomlBareKey(key)} = ${tomlString(value)}`);
  }
}

function renderCodexRemoteServer(lines, server) {
  lines.push(`url = ${tomlString(server.url)}`);
  appendTomlValue(lines, "bearer_token_env_var", server.bearerTokenEnvVar);
  appendTomlValue(lines, "oauth_resource", server.oauthResource);
  appendTomlValue(lines, "scopes", server.scopes);

  for (const [key, value] of Object.entries(server.headers ?? {})) {
    lines.push(`http_headers.${tomlBareKey(key)} = ${tomlString(value)}`);
  }

  for (const [key, value] of Object.entries(server.envHttpHeaders ?? {})) {
    lines.push(`env_http_headers.${tomlBareKey(key)} = ${tomlString(value)}`);
  }
}

function renderCodexCommonServerOptions(lines, server) {
  if (server.enabled === false) lines.push("enabled = false");
  appendTomlValue(lines, "required", server.required);
  appendTomlValue(lines, "startup_timeout_ms", server.startupTimeoutMs);
  appendTomlValue(lines, "startup_timeout_sec", server.startupTimeoutSec);
  appendTomlValue(lines, "tool_timeout_sec", server.toolTimeoutSec);
  appendTomlValue(lines, "enabled_tools", server.enabledTools);
  appendTomlValue(lines, "disabled_tools", server.disabledTools);
}

function appendTomlValue(lines, key, value) {
  if (value !== undefined) lines.push(`${key} = ${tomlValue(value)}`);
}

function serversForPlatform(servers, platform) {
  return Object.fromEntries(
    Object.entries(servers)
      .map(([name, server]) => [name, serverForPlatform(server, platform)])
      .filter(([, server]) => server),
  );
}

function serverForPlatform(server, platform) {
  if (server.platforms && !server.platforms.includes(platform)) return null;
  if (server.excludePlatforms?.includes(platform)) return null;
  if (server[platform] === false) return null;
  return { ...server, ...(server[platform] ?? {}) };
}

function validateSource(source, sourcePath) {
  if (!isObject(source)) throw new Error(`Failed to read ${sourcePath}`);
  validateKnownProperties(source, sourceKeys, sourcePath);
  if (!isObject(source.targets)) throw new Error(`${sourcePath}: targets must be an object`);
  if (!isObject(source.servers)) throw new Error(`${sourcePath}: servers must be an object`);
  validateOptionalString(source.backupDir, `${sourcePath}: backupDir`);

  for (const [platform, target] of Object.entries(source.targets)) {
    if (!platforms.includes(platform)) throw new Error(`${sourcePath}: unknown target ${platform}`);
    if (!isObject(target)) throw new Error(`${sourcePath}: targets.${platform} must be an object`);
    validateKnownProperties(target, targetKeysByPlatform[platform], `${sourcePath}: targets.${platform}`);
    if (platform === "claude") {
      validateRequiredString(target.mcpConfigPath, `${sourcePath}: targets.claude.mcpConfigPath`);
      validateOptionalString(target.settingsPath, `${sourcePath}: targets.claude.settingsPath`);
      validateOptionalString(target.projectPath, `${sourcePath}: targets.claude.projectPath`);
      if (target.scope !== undefined && !["user", "local", "project"].includes(target.scope)) {
        throw new Error(`${sourcePath}: targets.claude.scope must be "user", "local", or "project"`);
      }
    } else {
      validateRequiredString(target.configPath, `${sourcePath}: targets.${platform}.configPath`);
    }
  }

  validateStringArray(source.claudeAllowTools, `${sourcePath}: claudeAllowTools`);

  for (const [name, server] of Object.entries(source.servers)) {
    validateServerDefinition(server, `${sourcePath}: servers.${name}`);
  }
}

function validateServerDefinition(server, label) {
  if (!isObject(server)) throw new Error(`${label} must be an object`);
  validateKnownProperties(server, serverKeys, label);
  validateStringArray(server.platforms, `${label}.platforms`);
  validateStringArray(server.excludePlatforms, `${label}.excludePlatforms`);
  validatePlatforms(server.platforms, `${label}.platforms`);
  validatePlatforms(server.excludePlatforms, `${label}.excludePlatforms`);

  for (const platform of platforms) {
    if (server[platform] !== undefined && server[platform] !== false && !isObject(server[platform])) {
      throw new Error(`${label}.${platform} must be an object or false`);
    }
    if (isObject(server[platform])) {
      validateKnownProperties(server[platform], platformOverrideKeys, `${label}.${platform}`);
    }

    const effective = serverForPlatform(server, platform);
    if (effective) validateServerShape(effective, `${label} (${platform})`);
  }
}

function validateServerShape(server, label) {
  if (!["local", "remote"].includes(server.type)) {
    throw new Error(`${label}: type must be "local" or "remote"`);
  }

  if (server.type === "local" && typeof server.command !== "string") {
    throw new Error(`${label}: local servers require a command string`);
  }

  if (server.type === "remote" && typeof server.url !== "string") {
    throw new Error(`${label}: remote servers require a url string`);
  }

  if (server.transport !== undefined && !["http", "sse"].includes(server.transport)) {
    throw new Error(`${label}.transport must be "http" or "sse"`);
  }

  validateStringArray(server.args, `${label}.args`);
  validateStringArray(server.codexApprovalTools, `${label}.codexApprovalTools`);
  validateStringArray(server.enabledTools, `${label}.enabledTools`);
  validateStringArray(server.disabledTools, `${label}.disabledTools`);
  validateStringArray(server.scopes, `${label}.scopes`);
  validateStringMap(server.environment, `${label}.environment`);
  validateStringMap(server.headers, `${label}.headers`);
  validateStringMap(server.envHttpHeaders, `${label}.envHttpHeaders`);
  validateOptionalString(server.headersHelper, `${label}.headersHelper`);
  validateOptionalString(server.bearerTokenEnvVar, `${label}.bearerTokenEnvVar`);
  validateOptionalString(server.oauthResource, `${label}.oauthResource`);
  validateOptionalString(server.cwd, `${label}.cwd`);
  validateOptionalNumber(server.timeout, `${label}.timeout`);
  validateOptionalNumber(server.startupTimeoutMs, `${label}.startupTimeoutMs`);
  validateOptionalNumber(server.startupTimeoutSec, `${label}.startupTimeoutSec`);
  validateOptionalNumber(server.toolTimeoutSec, `${label}.toolTimeoutSec`);

  if (server.oauth !== undefined && server.oauth !== false && !isObject(server.oauth)) {
    throw new Error(`${label}.oauth must be an object or false`);
  }
}

function validateKnownProperties(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`${label}: unknown property ${key}`);
  }
}

function validateRequiredString(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
}

function validateOptionalString(value, label) {
  if (value !== undefined && typeof value !== "string") throw new Error(`${label} must be a string`);
}

function validateOptionalNumber(value, label) {
  if (value !== undefined && typeof value !== "number") throw new Error(`${label} must be a number`);
}

function validateStringArray(value, label) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function validateStringMap(value, label) {
  if (value === undefined) return;
  if (!isObject(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an object with string values`);
  }
}

function validatePlatforms(value, label) {
  if (value === undefined) return;
  for (const platform of value) {
    if (!platforms.includes(platform)) throw new Error(`${label} contains unknown platform ${platform}`);
  }
}

function parseArgs(args) {
  let sourcePath = process.env.MCP_SYNC_SOURCE ?? defaultSourcePath;
  let backupDir;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      console.log("Usage: sync-mcp-configs.mjs [--source path/to/servers.json] [--backup-dir path/to/backups]");
      process.exit(0);
    }

    if (arg === "--source") {
      sourcePath = args[i + 1];
      i += 1;
      if (!sourcePath) throw new Error("--source requires a path");
      continue;
    }

    if (arg === "--backup-dir") {
      backupDir = args[i + 1];
      i += 1;
      if (!backupDir) throw new Error("--backup-dir requires a path");
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    sourcePath: path.resolve(expandHome(sourcePath)),
    backupDir: backupDir ? path.resolve(expandHome(backupDir)) : undefined,
  };
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return structuredClone(fallback);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  backupExistingFile(filePath);
  fs.writeFileSync(filePath, value);
}

function backupExistingFile(filePath) {
  const resolved = path.resolve(filePath);
  if (backedUpPaths.has(resolved) || !fs.existsSync(resolved)) return;

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Refusing to overwrite non-file config path: ${resolved}`);

  let backupPath = backupPathForTarget(resolved);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const ext = path.extname(backupPath);
  const base = backupPath.slice(0, backupPath.length - ext.length);
  let counter = 1;

  while (fs.existsSync(backupPath)) {
    backupPath = `${base}.${counter}${ext}`;
    counter += 1;
  }

  fs.copyFileSync(resolved, backupPath);
  backedUpPaths.add(resolved);
  backupPaths.push(backupPath);
}

function backupPathForTarget(filePath) {
  const parsed = path.parse(filePath);
  const relative = filePath.slice(parsed.root.length).replace(/:/g, "");
  return path.join(backupDir, relative);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

function resolveConfigPath(filePath) {
  return path.resolve(expandHome(filePath));
}

function defaultBackupDir() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(os.homedir(), ".local", "state", "agent-tooling", "mcp-sync", "backups", timestamp);
}

function statePathForSource(sourcePath) {
  const extension = path.extname(sourcePath);
  const base = sourcePath.slice(0, sourcePath.length - extension.length);
  return `${base}.state.json`;
}

function expandHome(filePath) {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function parseTomlTableHeader(header) {
  const trimmed = stripTomlInlineComment(header).trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;

  const value = trimmed.slice(1, -1);
  const segments = [];
  let index = 0;

  while (index < value.length) {
    index = skipTomlWhitespace(value, index);
    const parsed = parseTomlKeySegment(value, index);
    if (!parsed) return null;
    segments.push(parsed.segment);
    index = skipTomlWhitespace(value, parsed.nextIndex);

    if (index === value.length) return segments;
    if (value[index] !== ".") return null;
    index += 1;
  }

  return segments;
}

function parseTomlKeySegment(value, index) {
  if (value[index] === '"') return parseTomlBasicStringKey(value, index);
  if (value[index] === "'") return parseTomlLiteralStringKey(value, index);

  const match = value.slice(index).match(/^[A-Za-z0-9_-]+/);
  if (!match) return null;
  return { segment: match[0], nextIndex: index + match[0].length };
}

function parseTomlBasicStringKey(value, index) {
  let cursor = index + 1;
  let escaped = false;

  while (cursor < value.length) {
    const char = value[cursor];
    if (!escaped && char === '"') {
      const raw = value.slice(index, cursor + 1);
      try {
        return { segment: JSON.parse(raw), nextIndex: cursor + 1 };
      } catch {
        return null;
      }
    }

    escaped = !escaped && char === "\\";
    if (char !== "\\") escaped = false;
    cursor += 1;
  }

  return null;
}

function parseTomlLiteralStringKey(value, index) {
  const end = value.indexOf("'", index + 1);
  if (end === -1) return null;
  return { segment: value.slice(index + 1, end), nextIndex: end + 1 };
}

function skipTomlWhitespace(value, index) {
  while (/\s/.test(value[index] ?? "")) index += 1;
  return index;
}

function stripTomlInlineComment(value) {
  let quote;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (!quote && char === "#") return value.slice(0, index);

    if (quote === '"') {
      if (!escaped && char === '"') quote = undefined;
      escaped = !escaped && char === "\\";
      if (char !== "\\") escaped = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }

    if (char === '"' || char === "'") quote = char;
  }

  return value;
}

function tomlArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlValue(value) {
  if (Array.isArray(value)) return tomlArray(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return tomlString(value);
}

function tomlString(value) {
  return JSON.stringify(value);
}

function tomlBareKey(value) {
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
