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
 */
export class RunTranscript {
  private readonly texts = new Map<string, string>();
  private readonly seenTools = new Map<string, string>();
  private readonly logged = new Set<string>();
  private readonly pending = new Map<
    string,
    {
      id: string;
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
    const id = `${key}@${message.timestamp ?? ''}`;
    const cut = key.lastIndexOf(':');
    const scope = cut >= 0 ? key.slice(0, cut) : '';
    const index = Number(key.slice(cut + 1));
    for (const [pendingKey, pending] of this.pending) {
      if (pending.scope !== scope) continue;
      // 同一下标换了新消息，或后面出现了新消息；旧下标的重复投影不算
      const ended = pendingKey === key ? pending.id !== id : pending.index < index;
      if (!ended) continue;
      this.pending.delete(pendingKey);
      if (!this.logged.has(pending.id)) {
        records.push(this.log(pending.id, pending.model, pending.usage));
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
      if (message.usage && !this.logged.has(id)) {
        this.pending.set(key, {
          id,
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
      if (!this.logged.has(pending.id)) {
        records.push(this.log(pending.id, pending.model, pending.usage));
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
