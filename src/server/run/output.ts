import type { PricingTable } from '@shared/usage/pricing';
import { priceUsage, type UsageCall } from './usageLog';

export type RunStatus =
  | 'success'
  | 'error'
  | 'blocked'
  | 'waiting'
  | 'exhausted'
  | 'timeout'
  | 'interrupted';

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}

export interface RunResult {
  status: RunStatus;
  exitCode: number;
  exitReason: string;
  sessionId: string;
  finalMessage: string;
  turns: number;
  durationMs: number;
  usage: RunUsage;
  sessionFile?: string;
  goal?: { status: string; note?: string };
}

export interface TranscriptPart {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

export interface TranscriptMessage {
  role: string;
  content?: TranscriptPart[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  stopReason?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  model?: string;
  timestamp?: number;
}

export type StreamRecord = Record<string, unknown>;

function textOf(message: TranscriptMessage): string {
  return (message.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
}

function toolResultText(message: TranscriptMessage): string {
  return (message.content ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * 把 worker 的整条 message-upsert 收成增量事件。流式中途的消息也带 stopReason 和零用量，
 * 所以一次调用的用量要等同一会话出现下一条消息（或轮次结束）才算定稿并落一行。
 *
 * 压缩/重启会让 worker 重放全部历史且下标移位（压缩摘要占位），同一逻辑调用会以新 key
 * 再次出现。消息的 timestamp 是请求开始时刻、重放时保持稳定，所以记账身份以 timestamp
 * （消息身份）而非 key（数组下标）为准：同一逻辑调用在新 key 下的投影不重复计。
 */
export class RunTranscript {
  private readonly texts = new Map<string, string>();
  private readonly seenTools = new Map<string, string>();
  private readonly logged = new Set<string>();
  private readonly pending = new Map<
    string,
    {
      id: string;
      usageKey: string;
      scope: string;
      index: number;
      model: string;
      usage: NonNullable<TranscriptMessage['usage']>;
    }
  >();
  finalText = '';
  readonly calls: UsageCall[] = [];

  constructor(
    private readonly provider: string,
    private readonly pricing: PricingTable,
    private readonly now: () => number = Date.now
  ) {}

  ingest(key: string, message: TranscriptMessage, parent: boolean): StreamRecord[] {
    const records: StreamRecord[] = [];
    // 压缩、重试会让下标复用；用消息时间戳区分不同调用，同一条消息的重复投影只记一次
    const stamp = message.timestamp ?? '';
    const id = `${key}@${stamp}`;
    // 记账身份：同一逻辑调用（timestamp 相同）跨下标复用、压缩移位、重启重放都只记一次
    const cut = key.lastIndexOf(':');
    const scope = cut >= 0 ? key.slice(0, cut) : '';
    // scope 限定在同一 child 会话内，避免两个并发 child 同毫秒开始的调用互相误并
    const usageKey = `${scope}@${stamp}`;
    const index = Number(key.slice(cut + 1));
    for (const [pendingKey, pending] of this.pending) {
      if (pending.scope !== scope) continue;
      if (pending.usageKey === usageKey && pendingKey !== key) {
        // 压缩/重启重放：同一逻辑调用移到了新下标，记账位置随消息迁移。
        // 只认权威的重放顺序（新下标更靠后）；乱序投影按普通下标规则处理，不冒误并的风险
        if (pending.index < index) {
          this.pending.delete(pendingKey);
          this.pending.set(key, { ...pending, id, index });
          break;
        }
      }
      // 同一下标换了新消息，或后面出现了新消息；旧下标的重复投影不算
      const ended = pendingKey === key ? pending.id !== id : pending.index < index;
      if (!ended) continue;
      this.pending.delete(pendingKey);
      if (!this.logged.has(pending.usageKey)) {
        records.push(this.log(pending.id, pending.model, pending.usage));
        this.logged.add(pending.usageKey);
      }
    }
    if (message.role === 'assistant') {
      const next = textOf(message);
      const prev = this.texts.get(key) ?? '';
      if (next && next !== prev) {
        const delta = next.startsWith(prev) ? next.slice(prev.length) : next;
        if (delta) records.push({ type: 'assistant.delta', text: delta });
        this.texts.set(key, next);
        if (parent) this.finalText = next;
      }
      for (const part of message.content ?? []) {
        if (part.type !== 'toolCall' || typeof part.id !== 'string' || !part.name) continue;
        const signature = JSON.stringify(part.arguments ?? null);
        if (this.seenTools.get(part.id) === signature) continue;
        this.seenTools.set(part.id, signature);
        records.push({
          type: 'tool.call',
          id: part.id,
          name: part.name,
          arguments: part.arguments ?? {},
        });
      }
      if (message.usage && !this.logged.has(usageKey)) {
        this.pending.set(key, {
          id,
          usageKey,
          scope,
          index,
          model: message.model || 'unknown',
          usage: message.usage,
        });
      }
    } else if (message.role === 'toolResult') {
      records.push({
        type: 'tool.result',
        ...(message.toolCallId ? { id: message.toolCallId } : {}),
        ...(message.toolName ? { name: message.toolName } : {}),
        text: toolResultText(message),
        ...(message.isError ? { isError: true } : {}),
      });
    }
    return records;
  }

  /** 轮次结束时补记最后一次调用的用量。 */
  flushTurn(): StreamRecord[] {
    const records: StreamRecord[] = [];
    for (const pending of this.pending.values()) {
      if (!this.logged.has(pending.usageKey)) {
        records.push(this.log(pending.id, pending.model, pending.usage));
        this.logged.add(pending.usageKey);
      }
    }
    this.pending.clear();
    return records;
  }

  usage(): RunUsage {
    const totals: RunUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
    for (const call of this.calls) {
      totals.input += call.inputTokens;
      totals.output += call.outputTokens;
      totals.cacheRead += call.cacheReadTokens;
      totals.cacheWrite += call.cacheWriteTokens;
      totals.costUsd =
        totals.costUsd === null || call.costUsd === null ? null : totals.costUsd + call.costUsd;
    }
    return this.calls.length > 0 ? totals : { ...totals, costUsd: null };
  }

  private log(
    id: string,
    model: string,
    usage: NonNullable<TranscriptMessage['usage']>
  ): StreamRecord {
    this.logged.add(id);
    const costUsd = priceUsage(model, usage, this.pricing);
    const call: UsageCall = {
      timestamp: new Date(this.now()).toISOString(),
      provider: this.provider,
      model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      costUsd,
    };
    this.calls.push(call);
    return {
      type: 'usage',
      provider: call.provider,
      model: call.model,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheReadTokens: call.cacheReadTokens,
      cacheWriteTokens: call.cacheWriteTokens,
      costUsd,
    };
  }
}

export function renderResult(result: RunResult, format: 'text' | 'json'): string {
  if (format === 'text') return result.finalMessage ? `${result.finalMessage}\n` : '';
  return `${JSON.stringify(result)}\n`;
}
