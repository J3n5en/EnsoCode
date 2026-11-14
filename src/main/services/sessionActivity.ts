/**
 * 会话最近工具调用的只读投影：只看 jsonl 里已有的 toolCall / toolResult，
 * 不返回任何工具输出。秘书用它判断一个会话到底在干什么、卡在哪一步。
 */
import type { ProjectedMessage } from '@shared/types/agent';

/** 命令摘要上限：够判断在跑什么，又不至于把整条脚本塞进上下文 */
export const ACTIVITY_COMMAND_MAX = 120;
export const ACTIVITY_LIMIT_DEFAULT = 20;
export const ACTIVITY_LIMIT_MAX = 50;

export interface SessionToolActivity {
  name: string;
  /** 有结果且不是错误才算成功；没有结果时见 pending */
  ok: boolean;
  /** 还没有 toolResult：仍在执行或那一轮被中断 */
  pending?: boolean;
  durationMs?: number;
  at?: number;
  /** bash 一类带命令的工具，只给前 ACTIVITY_COMMAND_MAX 字 */
  command?: string;
}

interface CallRecord {
  id: string | undefined;
  name: string;
  at?: number;
  command?: string;
}

function commandOf(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const command = (args as { command?: unknown }).command;
  if (typeof command !== 'string') return undefined;
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  return trimmed.length > ACTIVITY_COMMAND_MAX
    ? `${trimmed.slice(0, ACTIVITY_COMMAND_MAX)}…`
    : trimmed;
}

/**
 * 按调用顺序列出最近 limit 个工具调用。结果按 toolCallId 匹配，
 * 匹配不到的调用标 pending，而不是当成失败。
 */
export function projectSessionActivity(
  messages: readonly ProjectedMessage[],
  limit: number = ACTIVITY_LIMIT_DEFAULT
): SessionToolActivity[] {
  const calls: CallRecord[] = [];
  const results = new Map<string, { isError: boolean; durationMs?: number; at?: number }>();
  for (const message of messages) {
    if (message.role === 'toolResult') {
      if (!message.toolCallId) continue;
      results.set(message.toolCallId, {
        isError: message.isError === true,
        ...(typeof message.toolDurationMs === 'number'
          ? { durationMs: message.toolDurationMs }
          : {}),
        ...(typeof message.timestamp === 'number' ? { at: message.timestamp } : {}),
      });
      continue;
    }
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue;
      const command = commandOf(part.arguments);
      calls.push({
        id: part.id,
        name: part.name,
        ...(typeof message.timestamp === 'number' ? { at: message.timestamp } : {}),
        ...(command ? { command } : {}),
      });
    }
  }
  const kept = calls.slice(-Math.max(0, Math.floor(limit)));
  return kept.map((call) => {
    const result = call.id ? results.get(call.id) : undefined;
    return {
      name: call.name,
      ok: result ? !result.isError : false,
      ...(result ? {} : { pending: true }),
      ...(result?.durationMs === undefined ? {} : { durationMs: result.durationMs }),
      ...(result?.at === undefined && call.at === undefined ? {} : { at: result?.at ?? call.at }),
      ...(call.command ? { command: call.command } : {}),
    };
  });
}
