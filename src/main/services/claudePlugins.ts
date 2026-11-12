import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentTypeSpawnConfig, McpServerSpawnConfig } from '../../shared/types/agent';
import {
  CLAUDE_HOOK_EVENTS,
  type ClaudeHookEvent,
  type InstalledPluginInfo,
  type PluginCommandSpawn,
  type PluginComponentSummary,
  type PluginEntry,
  type PluginHookSpawn,
} from '../../shared/types/plugins';

export const DEFAULT_CLAUDE_PLUGINS_DIR = path.join(os.homedir(), '.claude', 'plugins');

const MAX_FILE_BYTES = 256 * 1024;
const READONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'NotebookRead',
  'TodoWrite',
]);

export interface InstalledPlugin {
  key: string;
  name: string;
  marketplace: string;
  version?: string;
  root: string;
}

export interface PluginAgentDef {
  name: string;
  description: string;
  systemPrompt: string;
  tools: AgentTypeSpawnConfig['tools'];
  skillPaths: string[];
}

export interface PluginComponents {
  description: string;
  skills: Array<{ name: string; path: string }>;
  commands: PluginCommandSpawn[];
  agents: PluginAgentDef[];
  mcpServers: McpServerSpawnConfig[];
  hooks: PluginHookSpawn[];
  unsupported: string[];
}

export interface PluginReadOptions {
  pluginsDir: string;
  env: Record<string, string | undefined>;
}

interface Vars {
  root: string;
  data: string;
  env: Record<string, string | undefined>;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export function expandPluginVars(input: string, vars: Vars): string {
  return input.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_match, name: string, fallback) => {
    if (name === 'CLAUDE_PLUGIN_ROOT') return vars.root;
    if (name === 'CLAUDE_PLUGIN_DATA') return vars.data;
    if (name.startsWith('user_config.')) return fallback ?? '';
    const value = vars.env[name];
    return value === undefined || value === '' ? (fallback ?? '') : value;
  });
}

function readJson(file: string): unknown {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function readMarkdown(file: string): { meta: Json; body: string } | null {
  let raw: string;
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw.trim() };
  let meta: unknown;
  try {
    meta = parseYaml(match[1]);
  } catch {
    meta = undefined;
  }
  return { meta: isRecord(meta) ? meta : {}, body: raw.slice(match[0].length).trim() };
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function listNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return text(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function manifestPaths(root: string, value: unknown, fallback: string): string[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const paths = entries
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .map((entry) => path.resolve(root, entry))
    .filter((entry) => entry === root || entry.startsWith(root + path.sep));
  return paths.length > 0 ? paths : [path.join(root, fallback)];
}

function markdownFiles(target: string, prefix: string[] = []): Array<[string, string[]]> {
  if (target.endsWith('.md')) return fs.existsSync(target) ? [[target, prefix]] : [];
  if (!isDir(target)) return [];
  return fs
    .readdirSync(target, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .flatMap((entry) => {
      const full = path.join(target, entry.name);
      if (entry.name.endsWith('.md') && !entry.isDirectory()) {
        return [[full, [...prefix, entry.name.slice(0, -3)]] as [string, string[]]];
      }
      return isDir(full) ? markdownFiles(full, [...prefix, entry.name]) : [];
    });
}

export function pluginDataDir(pluginsDir: string, key: string): string {
  return path.join(pluginsDir, 'data', key.replace(/[^a-zA-Z0-9_-]/g, '-'));
}

export function listInstalledPlugins(pluginsDir = DEFAULT_CLAUDE_PLUGINS_DIR): InstalledPlugin[] {
  const file = readJson(path.join(pluginsDir, 'installed_plugins.json'));
  const plugins = isRecord(file) && isRecord(file.plugins) ? file.plugins : {};
  const result: InstalledPlugin[] = [];
  for (const [key, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) continue;
    const existing = installs.filter(
      (install): install is Json => isRecord(install) && isDir(text(install.installPath))
    );
    const install = existing.find((entry) => entry.scope === 'user') ?? existing[0];
    if (!install) continue;
    const at = key.lastIndexOf('@');
    const version = text(install.version);
    result.push({
      key,
      name: at > 0 ? key.slice(0, at) : key,
      marketplace: at > 0 ? key.slice(at + 1) : '',
      ...(version ? { version } : {}),
      root: text(install.installPath),
    });
  }
  return result;
}

function marketplaceEntry(pluginsDir: string, plugin: InstalledPlugin): Json {
  const file = readJson(
    path.join(pluginsDir, 'marketplaces', plugin.marketplace, '.claude-plugin', 'marketplace.json')
  );
  const entries = isRecord(file) && Array.isArray(file.plugins) ? file.plugins : [];
  const entry = entries.find((item) => isRecord(item) && item.name === plugin.name);
  return isRecord(entry) ? entry : {};
}

function readManifest(pluginsDir: string, plugin: InstalledPlugin): Json {
  const own =
    readJson(path.join(plugin.root, '.claude-plugin', 'plugin.json')) ??
    readJson(path.join(plugin.root, '.codex-plugin', 'plugin.json'));
  const market = plugin.marketplace ? marketplaceEntry(pluginsDir, plugin) : {};
  const base = market.strict === false ? market : { description: market.description };
  return { ...base, ...(isRecord(own) ? own : {}) };
}

function readSkills(root: string, manifest: Json): PluginComponents['skills'] {
  const skills: PluginComponents['skills'] = [];
  const add = (dir: string) => {
    const doc = readMarkdown(path.join(dir, 'SKILL.md'));
    if (doc) skills.push({ name: text(doc.meta.name) || path.basename(dir), path: dir });
  };
  for (const target of manifestPaths(root, manifest.skills, 'skills')) {
    if (fs.existsSync(path.join(target, 'SKILL.md'))) {
      add(target);
      continue;
    }
    if (!isDir(target)) continue;
    for (const entry of fs.readdirSync(target).sort()) add(path.join(target, entry));
  }
  if (skills.length === 0 && manifest.skills === undefined) add(root);
  return skills;
}

function readCommands(
  root: string,
  manifest: Json,
  pluginName: string,
  vars: Vars
): PluginCommandSpawn[] {
  const commands: PluginCommandSpawn[] = [];
  for (const target of manifestPaths(root, manifest.commands, 'commands')) {
    for (const [file, parts] of markdownFiles(target)) {
      const doc = readMarkdown(file);
      if (!doc?.body) continue;
      const segments = parts.length > 0 ? parts : [path.basename(file, '.md')];
      const hint = text(doc.meta['argument-hint']);
      commands.push({
        name: [pluginName, ...segments].join(':'),
        description: text(doc.meta.description) || doc.body.split('\n')[0].trim(),
        ...(hint ? { argumentHint: hint } : {}),
        content: expandPluginVars(doc.body, vars),
        filePath: file,
      });
    }
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

function readAgents(
  root: string,
  manifest: Json,
  pluginName: string,
  skills: PluginComponents['skills'],
  vars: Vars
): PluginAgentDef[] {
  const agents: PluginAgentDef[] = [];
  for (const target of manifestPaths(root, manifest.agents, 'agents')) {
    for (const [file] of markdownFiles(target)) {
      const doc = readMarkdown(file);
      if (!doc) continue;
      const tools = listNames(doc.meta.tools).map((tool) => tool.replace(/\(.*$/, '').trim());
      const wanted = new Set(listNames(doc.meta.skills));
      agents.push({
        name: `${pluginName}:${text(doc.meta.name) || path.basename(file, '.md')}`,
        description: text(doc.meta.description),
        systemPrompt: expandPluginVars(doc.body, vars),
        tools:
          tools.length > 0 && tools.every((tool) => READONLY_TOOLS.has(tool)) ? 'readonly' : 'all',
        skillPaths: skills.filter((skill) => wanted.has(skill.name)).map((skill) => skill.path),
      });
    }
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

function stringMap(
  value: unknown,
  vars: Vars,
  dropEmpty: boolean
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, raw]) => [key, expandPluginVars(raw, vars)] as const)
    .filter(([, expanded]) => !dropEmpty || expanded !== '');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mcpSources(root: string, manifest: Json): Json[] {
  const declared = manifest.mcpServers;
  if (isRecord(declared)) return [declared];
  const files =
    declared === undefined
      ? [path.join(root, '.mcp.json')]
      : manifestPaths(root, declared, '.mcp.json');
  return files.map(readJson).filter(isRecord);
}

function readMcpServers(
  root: string,
  manifest: Json,
  pluginKey: string,
  vars: Vars
): McpServerSpawnConfig[] {
  const servers: McpServerSpawnConfig[] = [];
  for (const source of mcpSources(root, manifest)) {
    const map = isRecord(source.mcpServers) ? source.mcpServers : source;
    for (const [name, raw] of Object.entries(map)) {
      if (!isRecord(raw) || servers.some((server) => server.name === name)) continue;
      const declared = text(raw.type) || text(raw.transport);
      const transport =
        declared === 'http' || declared === 'sse' || declared === 'stdio'
          ? declared
          : raw.command
            ? 'stdio'
            : 'http';
      const base = { id: `plugin:${pluginKey}:${name}`, name, transport } as const;
      if (transport === 'stdio') {
        const command = expandPluginVars(text(raw.command), vars);
        if (!command) continue;
        const args = Array.isArray(raw.args)
          ? raw.args.filter((arg): arg is string => typeof arg === 'string')
          : [];
        const env = stringMap(raw.env, vars, false);
        servers.push({
          ...base,
          command,
          ...(args.length > 0 ? { args: args.map((arg) => expandPluginVars(arg, vars)) } : {}),
          ...(env ? { env } : {}),
        });
        continue;
      }
      const url = expandPluginVars(text(raw.url), vars);
      if (!/^https?:\/\//i.test(url)) continue;
      const headers = stringMap(raw.headers, vars, true);
      servers.push({ ...base, url, ...(headers ? { headers } : {}) });
    }
  }
  return servers;
}

function readHooks(
  root: string,
  manifest: Json,
  pluginName: string,
  dataDir: string,
  unsupported: Set<string>
): PluginHookSpawn[] {
  const declared = manifest.hooks;
  const sources: unknown[] = [readJson(path.join(root, 'hooks', 'hooks.json'))];
  if (isRecord(declared)) sources.push(declared);
  else if (declared !== undefined) {
    for (const file of manifestPaths(root, declared, 'hooks/hooks.json')) {
      if (file !== path.join(root, 'hooks', 'hooks.json')) sources.push(readJson(file));
    }
  }
  const hooks: PluginHookSpawn[] = [];
  for (const source of sources) {
    if (!isRecord(source)) continue;
    const events = isRecord(source.hooks) ? source.hooks : source;
    for (const [event, groups] of Object.entries(events)) {
      if (!Array.isArray(groups)) continue;
      if (!(CLAUDE_HOOK_EVENTS as readonly string[]).includes(event)) {
        unsupported.add(`hooks:${event}`);
        continue;
      }
      for (const group of groups) {
        if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
        const matcher = text(group.matcher);
        for (const hook of group.hooks) {
          if (!isRecord(hook)) continue;
          if (hook.type !== 'command') {
            unsupported.add(`hooks:${text(hook.type) || 'unknown'}`);
            continue;
          }
          const command = text(hook.command);
          if (!command) continue;
          const timeout = typeof hook.timeout === 'number' && hook.timeout > 0 ? hook.timeout : 0;
          hooks.push({
            plugin: pluginName,
            root,
            dataDir,
            event: event as ClaudeHookEvent,
            ...(matcher ? { matcher } : {}),
            command,
            ...(timeout ? { timeoutSec: Math.min(timeout, 3600) } : {}),
          });
        }
      }
    }
  }
  return hooks;
}

const UNSUPPORTED_KEYS: Array<[string, string]> = [
  ['lspServers', '.lsp.json'],
  ['outputStyles', 'output-styles'],
  ['monitors', ''],
  ['userConfig', ''],
];

export function readPluginComponents(
  plugin: InstalledPlugin,
  options: PluginReadOptions
): PluginComponents {
  const manifest = readManifest(options.pluginsDir, plugin);
  const pluginName = text(manifest.name) || plugin.name;
  const dataDir = pluginDataDir(options.pluginsDir, plugin.key);
  const vars: Vars = { root: plugin.root, data: dataDir, env: options.env };
  const unsupported = new Set<string>();
  const skills = readSkills(plugin.root, manifest);
  const components: PluginComponents = {
    description: text(manifest.description),
    skills,
    commands: readCommands(plugin.root, manifest, pluginName, vars),
    agents: readAgents(plugin.root, manifest, pluginName, skills, vars),
    mcpServers: readMcpServers(plugin.root, manifest, plugin.key, vars),
    hooks: readHooks(plugin.root, manifest, pluginName, dataDir, unsupported),
    unsupported: [],
  };
  for (const [key, file] of UNSUPPORTED_KEYS) {
    if (manifest[key] !== undefined || (file && fs.existsSync(path.join(plugin.root, file)))) {
      unsupported.add(key);
    }
  }
  components.unsupported = [...unsupported];
  return components;
}

export function summarizeComponents(components: PluginComponents): PluginComponentSummary {
  return {
    skills: components.skills.map((skill) => skill.name),
    commands: components.commands.map((command) => command.name),
    agents: components.agents.map((agent) => agent.name),
    mcpServers: components.mcpServers.map((server) => ({
      name: server.name,
      target:
        server.transport === 'stdio'
          ? [server.command, ...(server.args ?? [])].join(' ')
          : (server.url ?? ''),
    })),
    hooks: components.hooks.map((hook) => ({ event: hook.event, command: hook.command })),
    unsupported: components.unsupported,
  };
}

export interface ResolvedPlugins {
  skillPaths: string[];
  commands: PluginCommandSpawn[];
  agents: PluginAgentDef[];
  mcpServers: McpServerSpawnConfig[];
  hooks: PluginHookSpawn[];
}

export function resolvePluginsForSpawn(
  entries: readonly PluginEntry[],
  options: PluginReadOptions
): ResolvedPlugins {
  const resolved: ResolvedPlugins = {
    skillPaths: [],
    commands: [],
    agents: [],
    mcpServers: [],
    hooks: [],
  };
  const enabled = new Set(entries.filter((entry) => entry.enabled).map((entry) => entry.key));
  if (enabled.size === 0) return resolved;
  for (const plugin of listInstalledPlugins(options.pluginsDir)) {
    if (!enabled.has(plugin.key)) continue;
    const components = readPluginComponents(plugin, options);
    resolved.skillPaths.push(...components.skills.map((skill) => skill.path));
    resolved.commands.push(...components.commands);
    resolved.agents.push(...components.agents);
    resolved.mcpServers.push(...components.mcpServers);
    resolved.hooks.push(...components.hooks);
  }
  return resolved;
}

/**
 * 展示摘要用的环境：已设置的变量只展开成 `${NAME}` 占位符，未设置的照旧走缺省值。
 * 不直接保留所有占位符原样，是为了让「哪些服务会启动」（URL 协议、命令非空）的判定与真正启动时一致。
 */
function placeholderEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([, value]) => value)
      .map(([name]) => [name, `\${${name}}`])
  );
}

export function listInstalledPluginInfo(
  pluginsDir = DEFAULT_CLAUDE_PLUGINS_DIR
): InstalledPluginInfo[] {
  // 摘要经 IPC 发给界面（远端/手机也能拿到），环境变量值可能是密钥，只能留在 Main；真正启动走 resolvePluginsForSpawn
  const env = placeholderEnv(process.env);
  return listInstalledPlugins(pluginsDir).map((plugin) => {
    const components = readPluginComponents(plugin, { pluginsDir, env });
    return {
      key: plugin.key,
      name: plugin.name,
      description: components.description,
      ...(plugin.version ? { version: plugin.version } : {}),
      marketplace: plugin.marketplace,
      components: summarizeComponents(components),
    };
  });
}
