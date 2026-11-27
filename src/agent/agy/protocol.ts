import type {
  AgyConfigOption,
  AgyContextUsage,
  AgyModeInfo,
  AgyPermissionRequest,
} from '@shared/agy/types';
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

export interface AgyTurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

/**
 * 一轮回复给 pi 的 usage。PromptResponse.usage 是这一轮 agy 内部所有模型调用的累加（真实会话一轮 5.3M），
 * 拿它当上下文占用会让 pi 判成溢出去压缩；占用只认最后一个 usage_update 的 used。
 * pi 的溢出判断看 input + cacheRead，阈值看 totalTokens，Enso 的占用看 input + cacheRead + cacheWrite：
 * 三处都只放 used。output 取各 prompt 的 outputTokens 之和，只进状态栏的输出量和速度，不参与占用。
 * 没收到 usage_update（或 used 为 0）就全给 0，pi 和 Enso 都会跳过这条、回落到估算。
 */
export function agyTurnUsage(
  context: AgyContextUsage | undefined,
  responses: readonly unknown[]
): AgyTurnUsage {
  const used = context?.used ?? 0;
  if (!(used > 0)) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let output = 0;
  for (const response of responses) {
    const value = record(record(response)?.usage)?.outputTokens;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) output += value;
  }
  return { input: used, output, cacheRead: 0, cacheWrite: 0, totalTokens: used };
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
