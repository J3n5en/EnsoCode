import type { AgyConfigOption, AgyModeInfo, AgyPermissionRequest } from '@shared/agy/types';
import { agyVersionAtLeast } from '@shared/agy/version';

/** agy 1.5.18 不报 mcpCapabilities，但 session/new 里的 HTTP MCP 照样接（见计划文档 Live findings）。 */
const HTTP_MCP_SINCE = '1.5.18';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseInitialize(
  result: unknown
): { version: string; canAppendSystemPrompt: boolean; httpMcp: boolean } | undefined {
  const root = record(result);
  const info = record(root?.agentInfo);
  const version = typeof info?.version === 'string' ? info.version : '';
  if (!version) return undefined;
  const capabilities = record(root?.agentCapabilities);
  const meta = record(record(capabilities?._meta)?.antigravity);
  const systemPrompt = record(meta?.systemPrompt);
  const httpMcp =
    record(capabilities?.mcpCapabilities)?.http === true ||
    agyVersionAtLeast(version, HTTP_MCP_SINCE);
  return { version, canAppendSystemPrompt: systemPrompt?.append === true, httpMcp };
}

function selectOptions(value: unknown): AgyConfigOption['options'] {
  if (!Array.isArray(value)) return [];
  const options: AgyConfigOption['options'] = [];
  for (const entry of value) {
    const row = record(entry);
    if (!row || typeof row.value !== 'string' || !row.value) continue;
    options.push({
      value: row.value,
      name: typeof row.name === 'string' && row.name ? row.name : row.value,
    });
  }
  return options;
}

export function parseSessionSetup(result: unknown):
  | {
      sessionId: string;
      configOptions: AgyConfigOption[];
      modes: AgyModeInfo[];
      currentModeId?: string;
    }
  | undefined {
  const root = record(result);
  const sessionId = typeof root?.sessionId === 'string' ? root.sessionId : '';
  if (!sessionId) return undefined;
  const configOptions: AgyConfigOption[] = [];
  if (Array.isArray(root?.configOptions)) {
    for (const entry of root.configOptions) {
      const row = record(entry);
      const id = row && typeof row.id === 'string' ? row.id : '';
      if (!id || row?.type !== 'select') continue;
      configOptions.push({
        id,
        type: 'select',
        options: selectOptions(row?.options),
        ...(typeof row?.category === 'string' ? { category: row.category } : {}),
        ...(typeof row?.currentValue === 'string' ? { currentValue: row.currentValue } : {}),
      });
    }
  }
  const modesRoot = record(root?.modes);
  const modes: AgyModeInfo[] = [];
  if (Array.isArray(modesRoot?.availableModes)) {
    for (const entry of modesRoot.availableModes) {
      const row = record(entry);
      if (!row || typeof row.id !== 'string') continue;
      modes.push({ id: row.id, ...(typeof row.name === 'string' ? { name: row.name } : {}) });
    }
  }
  return {
    sessionId,
    configOptions,
    modes,
    ...(typeof modesRoot?.currentModeId === 'string'
      ? { currentModeId: modesRoot.currentModeId }
      : {}),
  };
}

export function configValue(options: readonly AgyConfigOption[], id: string): string | undefined {
  return options.find((option) => option.id === id)?.currentValue;
}

export function thinkingValues(options: readonly AgyConfigOption[]): string[] {
  const option = options.find(
    (entry) => entry.id === 'thought_level' || entry.category === 'thought_level'
  );
  return option?.options.map((entry) => entry.value) ?? [];
}

export function usageFromPrompt(result: unknown): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
} {
  const usage = record(record(result)?.usage);
  const numberOf = (key: string) => (typeof usage?.[key] === 'number' ? usage[key] : 0);
  const cacheRead = numberOf('cachedReadTokens');
  const input = numberOf('inputTokens') + cacheRead;
  const output = numberOf('outputTokens');
  return {
    input,
    output,
    cacheRead,
    cacheWrite: numberOf('cachedWriteTokens'),
    totalTokens: numberOf('totalTokens') || input + output,
  };
}

export function parsePermissionRequest(params: unknown): AgyPermissionRequest | undefined {
  const root = record(params);
  const toolCall = record(root?.toolCall);
  const toolCallId = typeof toolCall?.toolCallId === 'string' ? toolCall.toolCallId : '';
  if (!toolCallId || !Array.isArray(root?.options)) return undefined;
  const options = [];
  for (const entry of root.options) {
    const row = record(entry);
    if (!row || typeof row.optionId !== 'string' || typeof row.kind !== 'string') continue;
    options.push({
      optionId: row.optionId,
      kind: row.kind,
      ...(typeof row.name === 'string' ? { name: row.name } : {}),
    });
  }
  return {
    toolCall: {
      toolCallId,
      ...(typeof toolCall?.name === 'string' ? { name: toolCall.name } : {}),
      ...(typeof toolCall?.title === 'string' ? { title: toolCall.title } : {}),
      ...(typeof toolCall?.kind === 'string' ? { kind: toolCall.kind } : {}),
      ...(toolCall?.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
    },
    options,
  };
}
