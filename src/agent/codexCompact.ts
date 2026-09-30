import {
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { createEnsoCompactHandler } from './ensoCompact/extension';
import type { EnsoCompactOptions } from './ensoCompact/types';

/**
 * Codex 原生压缩（Remote Compaction v2）：切点前缀 + `compaction_trigger` 发到 Codex，
 * 取回加密 checkpoint 存进 CompactionEntry.details；可读摘要仍由 smart 生成。
 * 请求时仅对同 provider 的 Codex 模型把摘要消息换成 checkpoint，换模型自然回退可读摘要。
 */
const CODEX_API = 'openai-codex-responses';

type CheckpointItem = { type: 'compaction'; encrypted_content: string };
type Checkpoint = { provider: string; item: CheckpointItem };
type Json = Record<string, unknown>;

export interface CodexCompactOptions extends EnsoCompactOptions {
  fetch?: typeof fetch;
}

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function extractCompactionItem(raw: string): CheckpointItem | undefined {
  const found = new Set<string>();
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    const response = isRecord(event.response) ? event.response : undefined;
    if (event.type === 'error' || event.type === 'response.failed') {
      const error = isRecord(event.error)
        ? event.error
        : isRecord(response?.error)
          ? response.error
          : event;
      throw new Error(String(error.message ?? 'Codex compaction failed'));
    }
    const items =
      event.type === 'response.output_item.done'
        ? [event.item]
        : event.type === 'response.completed' && Array.isArray(response?.output)
          ? response.output
          : [];
    for (const item of items) {
      if (
        isRecord(item) &&
        item.type === 'compaction' &&
        typeof item.encrypted_content === 'string'
      )
        if (item.encrypted_content) found.add(item.encrypted_content);
    }
  }
  const [encrypted] = found;
  return found.size === 1 && encrypted
    ? { type: 'compaction', encrypted_content: encrypted }
    : undefined;
}

function checkpointOf(entry: unknown): Checkpoint | undefined {
  if (!isRecord(entry) || entry.type !== 'compaction' || !isRecord(entry.details)) return;
  const checkpoint = entry.details.codexCheckpoint;
  if (!isRecord(checkpoint) || typeof checkpoint.provider !== 'string') return;
  const item = checkpoint.item;
  if (!isRecord(item) || item.type !== 'compaction' || typeof item.encrypted_content !== 'string')
    return;
  return { provider: checkpoint.provider, item: item as CheckpointItem };
}

function summaryText(summary: string): string | undefined {
  const [message] = convertToLlm([
    { role: 'compactionSummary', summary, tokensBefore: 0, timestamp: 0 },
  ]);
  const block = Array.isArray(message?.content) ? message.content[0] : undefined;
  return block?.type === 'text' ? block.text : undefined;
}

function soleInputText(item: unknown): string | undefined {
  if (!isRecord(item) || item.role !== 'user' || !Array.isArray(item.content)) return;
  const [part, ...rest] = item.content;
  return rest.length === 0 && isRecord(part) && part.type === 'input_text'
    ? String(part.text)
    : undefined;
}

export function applyCodexCheckpoints(
  payload: unknown,
  entries: readonly unknown[],
  provider: string
): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return payload;
  const byText = new Map<string, CheckpointItem>();
  for (const entry of entries) {
    const checkpoint = checkpointOf(entry);
    if (checkpoint?.provider !== provider) continue;
    const text = summaryText(String((entry as Json).summary ?? ''));
    if (text) byText.set(text, checkpoint.item);
  }
  if (byText.size === 0) return payload;
  let changed = false;
  const input = payload.input.map((item) => {
    const text = soleInputText(item);
    const checkpoint = text === undefined ? undefined : byText.get(text);
    if (!checkpoint) return item;
    changed = true;
    return { ...checkpoint };
  });
  return changed ? { ...payload, input } : payload;
}

async function compactPrefix(
  ctx: ExtensionContext,
  branch: SessionEntry[],
  keptId: string,
  signal: AbortSignal,
  baseFetch: typeof fetch
): Promise<CheckpointItem | undefined> {
  const model = ctx.model;
  const index = branch.findIndex((entry) => entry.id === keptId);
  if (!model || index <= 0) return;
  const { messages } = buildSessionContext(branch, branch[index - 1]!.id);
  if (messages.length === 0) return;
  const prefix = branch.slice(0, index);
  let raw: Promise<string> | undefined;
  await ctx.modelRegistry.complete(
    model,
    { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(messages) },
    {
      signal,
      transport: 'sse',
      onPayload: (payload: unknown) => {
        const next = applyCodexCheckpoints(payload, prefix, model.provider);
        if (!isRecord(next) || !Array.isArray(next.input)) return next;
        return { ...next, input: [...next.input, { type: 'compaction_trigger' }] };
      },
      fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const response = await baseFetch(input, init);
        if (response.ok) raw = response.clone().text();
        return response;
      },
    }
  );
  return raw ? extractCompactionItem(await raw) : undefined;
}

export function createCodexCompactHandler(
  options: CodexCompactOptions = {},
  smart = createEnsoCompactHandler(options)
) {
  return async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    const model = ctx.model;
    if (model?.api !== CODEX_API) return smart(event, ctx);
    const branch = (event.branchEntries ?? ctx.sessionManager.getBranch()) as SessionEntry[];
    const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const remote = (keptId: string, signal: AbortSignal) =>
      compactPrefix(ctx, branch, keptId, signal, baseFetch).catch((error) => {
        if (!signal.aborted) console.warn('[codex-compact] remote compaction failed:', error);
        return undefined;
      });
    const piCut = event.preparation.firstKeptEntryId;
    const early = new AbortController();
    // 与 smart 并行：切点未被 smart 后移时直接复用
    const initial = remote(piCut, AbortSignal.any([event.signal, early.signal]));
    try {
      const result = await smart(event, ctx);
      if (!result || !('compaction' in result) || !result.compaction || event.signal.aborted)
        return result;
      const keptId = result.compaction.firstKeptEntryId;
      if (keptId !== piCut) early.abort();
      const item = await (keptId === piCut ? initial : remote(keptId, event.signal));
      if (!item) return result;
      return {
        ...result,
        compaction: {
          ...result.compaction,
          details: { codexCheckpoint: { provider: model.provider, item } },
        },
      };
    } finally {
      early.abort();
    }
  };
}

export function createCodexCompactFactory(options: CodexCompactOptions = {}) {
  return (pi: ExtensionAPI) => {
    pi.on('session_before_compact', createCodexCompactHandler(options));
    pi.on('before_provider_request', (event, ctx) => {
      if (ctx.model?.api !== CODEX_API) return;
      const next = applyCodexCheckpoints(
        event.payload,
        ctx.sessionManager.getBranch(),
        ctx.model.provider
      );
      return next === event.payload ? undefined : next;
    });
  };
}
