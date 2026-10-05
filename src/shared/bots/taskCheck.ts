import type { TaskCheck } from '../types/bot';

/** 协作类工具的输出会回显任务 / 验收文本，不算执行证据 */
const COORDINATION_TOOLS = new Set([
  'delegate',
  'check_delegation',
  'group_tasks',
  'group_history',
  'routine_propose',
]);

interface OutputMessage {
  role: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  content: readonly { type: string; text?: string }[];
}

/** schema 校验前归一化：字符串视为 output-contains；null / 空串视为未传 */
export function normalizeTaskCheck(value: unknown): unknown {
  if (value === null) return undefined;
  if (typeof value === 'string')
    return value.trim() ? { kind: 'output-contains', text: value } : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === 'string' ? record.kind.replace(/_/g, '-') : record.kind;
  return { ...record, kind: kind ?? 'output-contains' };
}

/** 自 since 起，按 toolCallId 取最终结果；最终为错误的不计，中途 PASS 不能沿用 */
export function checkPassed(
  check: TaskCheck,
  messages: readonly OutputMessage[],
  since: number
): boolean {
  const finals = new Map<string, OutputMessage>();
  messages.forEach((message, index) => {
    if (message.role !== 'toolResult' || (message.timestamp ?? 0) < since) return;
    finals.set(message.toolCallId ?? `#${index}`, message);
  });
  return [...finals.values()].some(
    (message) =>
      !message.isError &&
      !COORDINATION_TOOLS.has(message.toolName ?? '') &&
      message.content.some((part) => part.type === 'text' && part.text?.includes(check.text))
  );
}

export const checkFailureText = (check: TaskCheck) =>
  `验收未通过：未在工具输出中看到「${check.text}」`;
