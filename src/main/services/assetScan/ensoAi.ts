import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { DiscoveredInstruction } from './instructions';
import type { DiscoveredMcpServer } from './mcp';

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

/** 读取 EnsoAI settings.json 中 enso-settings.state 下的某个数组字段 */
function readStateArray(settingsPath: string, key: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return [];
  }
  const state = (parsed as { 'enso-settings'?: { state?: Record<string, unknown> } })?.[
    'enso-settings'
  ]?.state;
  const value = state?.[key];
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
      )
    : [];
}

/** EnsoAI 的 mcpServers：数组形态，transportType 区分 stdio/http */
export function readEnsoAiMcp(settingsPath: string): DiscoveredMcpServer[] {
  return readStateArray(settingsPath, 'mcpServers').flatMap((item) => {
    const name = asText(item.name) || asText(item.id);
    const url = asText(item.url);
    const command = asText(item.command);
    if (!name || (!command && !url)) return [];

    const rawType = asText(item.transportType).toLowerCase();
    return [
      {
        name,
        transport:
          rawType === 'sse' ? ('sse' as const) : url ? ('http' as const) : ('stdio' as const),
        command: command || undefined,
        args: command ? asStringArray(item.args) : undefined,
        env: command ? asStringRecord(item.env) : undefined,
        url: url || undefined,
      },
    ];
  });
}

/** EnsoAI 的 promptPresets：指令内容直接存 settings，没有对应文件 */
export function readEnsoAiPrompts(settingsPath: string): DiscoveredInstruction[] {
  return readStateArray(settingsPath, 'promptPresets').flatMap((item) => {
    const content = asText(item.content);
    if (!content) return [];
    return [
      {
        name: asText(item.name) || 'prompt',
        content,
        location: 'EnsoAI · 提示预设',
        bytes: Buffer.byteLength(content, 'utf8'),
        hash: createHash('sha256').update(content).digest('hex'),
      },
    ];
  });
}
