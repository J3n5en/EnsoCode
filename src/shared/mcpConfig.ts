import type { McpTransport } from './types';

export interface DiscoveredMcpServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export type ParseMcpImportResult =
  | { ok: true; servers: DiscoveredMcpServer[] }
  | { ok: false; error: 'invalid-json' | 'empty' };

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

/** http/sse 请求头：只收非空名字的字符串值，空表视为没有 */
export function mcpHeaders(value: unknown): Record<string, string> | undefined {
  const headers = asStringRecord(value);
  delete headers[''];
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** 设置页文本框：每行 `Name: value`，按第一个冒号拆（请求头名不含冒号） */
export function parseMcpHeaderLines(text: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon).trim() : '';
    if (name) headers[name] = line.slice(colon + 1).trim();
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export const formatMcpHeaderLines = (headers?: Record<string, string>): string =>
  Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');

function toTransport(raw: unknown, url: string): McpTransport {
  const value = asText(raw).toLowerCase();
  if (value === 'sse') return 'sse';
  if (value === 'http' || value === 'streamable-http') return 'http';
  if (value === 'stdio') return 'stdio';
  return url ? 'http' : 'stdio';
}

/** 解析 { name: { command, args, env, url, type } } 形态的服务器表 */
export function parseServerMap(servers: unknown): DiscoveredMcpServer[] {
  if (!servers || typeof servers !== 'object') return [];
  const result: DiscoveredMcpServer[] = [];

  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const config = raw as Record<string, unknown>;
    const url = asText(config.url) || asText(config.serverUrl);
    const command = asText(config.command);
    if (!command && !url) continue;

    const headers = command ? undefined : mcpHeaders(config.headers);
    result.push({
      name,
      transport: toTransport(config.type ?? config.transport, url),
      command: command || undefined,
      args: command ? asStringArray(config.args) : undefined,
      env: command ? asStringRecord(config.env) : undefined,
      url: url || undefined,
      ...(headers ? { headers } : {}),
    });
  }

  return result;
}

const stripFence = (text: string): string => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
};

const wrapNamedFragment = (text: string): string => {
  if (text.startsWith('"') && !text.startsWith('{') && !text.startsWith('[')) {
    return `{${text}}`;
  }
  return text;
};

const unwrapServerMap = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  if (obj.mcpServers != null) return obj.mcpServers;
  if (obj.mcp_servers != null) return obj.mcp_servers;
  if (obj.servers != null) return obj.servers;
  const mcp = obj.mcp;
  if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
    const nested = (mcp as Record<string, unknown>).servers;
    if (nested != null) return nested;
  }
  return value;
};

const isSingleServer = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return Boolean(asText(obj.command) || asText(obj.url) || asText(obj.serverUrl));
};

const fallbackName = (obj: Record<string, unknown>): string => {
  const command = asText(obj.command);
  if (!command) return 'mcp';
  const base = command.split(/[\\/]/).pop()?.trim();
  return base || 'mcp';
};

const parseOneOrMap = (value: unknown): DiscoveredMcpServer[] => {
  if (Array.isArray(value)) return value.flatMap(parseOneOrMap);
  if (isSingleServer(value)) {
    const name = asText(value.name) || asText(value.id) || fallbackName(value);
    return parseServerMap({ [name]: value });
  }
  return parseServerMap(value);
};

/** 粘贴导入：单条配置、服务器表、Cursor/Claude mcpServers、代码围栏 */
export function parseMcpImportJson(text: string): ParseMcpImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wrapNamedFragment(stripFence(text)));
  } catch {
    return { ok: false, error: 'invalid-json' };
  }

  const servers = Array.isArray(parsed)
    ? parsed.flatMap(parseOneOrMap)
    : parseOneOrMap(unwrapServerMap(parsed));

  if (servers.length === 0) return { ok: false, error: 'empty' };
  return { ok: true, servers };
}
