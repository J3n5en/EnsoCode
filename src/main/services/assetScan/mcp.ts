import fs from 'node:fs';
import type { McpTransport } from '@shared/types';
import { parse as parseToml } from 'smol-toml';

export interface DiscoveredMcpServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const asStringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') result[key] = item;
  }
  return result;
};

function toTransport(raw: unknown, url: string): McpTransport {
  const value = asText(raw).toLowerCase();
  if (value === 'sse') return 'sse';
  if (value === 'http' || value === 'streamable-http') return 'http';
  if (value === 'stdio') return 'stdio';
  return url ? 'http' : 'stdio';
}

/** 解析 { name: { command, args, env, url, type } } 形态的服务器表 */
function parseServerMap(servers: unknown): DiscoveredMcpServer[] {
  if (!servers || typeof servers !== 'object') return [];
  const result: DiscoveredMcpServer[] = [];

  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const config = raw as Record<string, unknown>;
    const url = asText(config.url) || asText(config.serverUrl);
    const command = asText(config.command);
    if (!command && !url) continue;

    result.push({
      name,
      transport: toTransport(config.type ?? config.transport, url),
      command: command || undefined,
      args: command ? asStringArray(config.args) : undefined,
      env: command ? asStringRecord(config.env) : undefined,
      url: url || undefined,
    });
  }

  return result;
}

/** Claude Code (~/.claude.json)：合并全局与各项目下的 mcpServers */
export function readClaudeMcp(file: string): DiscoveredMcpServer[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    mcpServers?: unknown;
    projects?: Record<string, { mcpServers?: unknown }>;
  };

  const servers = parseServerMap(raw.mcpServers);
  const seen = new Set(servers.map((server) => server.name));

  for (const project of Object.values(raw.projects ?? {})) {
    for (const server of parseServerMap(project?.mcpServers)) {
      if (seen.has(server.name)) continue;
      seen.add(server.name);
      servers.push(server);
    }
  }

  return servers;
}

/** Claude Desktop / Cursor：{ mcpServers: {...} } */
export function readJsonMcp(file: string): DiscoveredMcpServer[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: unknown };
  return parseServerMap(raw.mcpServers);
}

/** Codex (~/.codex/config.toml)：[mcp_servers.<name>] */
export function readCodexMcp(file: string): DiscoveredMcpServer[] {
  const raw = parseToml(fs.readFileSync(file, 'utf8')) as { mcp_servers?: unknown };
  return parseServerMap(raw.mcp_servers);
}
