import type { InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { PLUGIN_MESSAGE_TYPE } from '@shared/extensionPlugins/protocol';

const DISCARD = 'turn_discard';
const RECALL = 'turn_recall';

interface BranchEntry {
  id: string;
  type: string;
  customType?: string;
  content?: unknown;
  targetId?: string;
  message?: { role: string; content?: unknown };
}

export interface DiscardPlan {
  /** 触发本轮的插件投递条目 */
  triggers: string[];
  /** 本轮已落盘的 assistant / toolResult 条目 */
  run: string[];
}

/** 不参与模型上下文的状态条目，回溯时跳过 */
const PASSIVE = new Set([
  'custom',
  'model_change',
  'thinking_level_change',
  'label',
  'session_info',
  'usage',
  'context_edit',
]);

const NOT_DELIVERY = `${DISCARD} only works for a turn triggered by an automatic plugin delivery, not by the user.`;

function toolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    part?.type === 'toolCall' && typeof part.name === 'string' ? [part.name] : []
  );
}

/** 从分支末尾回溯本轮：只接受插件投递触发、且本轮除 turn_discard 外没有任何工具调用 */
export function planTurnDiscard(branch: readonly BranchEntry[]): DiscardPlan | string {
  const plan: DiscardPlan = { triggers: [], run: [] };
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (PASSIVE.has(entry.type)) continue;
    if (entry.type === 'custom_message' && entry.customType === PLUGIN_MESSAGE_TYPE) {
      plan.triggers.unshift(entry.id);
      continue;
    }
    if (plan.triggers.length > 0) break;
    const role = entry.type === 'message' ? entry.message?.role : undefined;
    if (role === 'toolResult') {
      plan.run.unshift(entry.id);
      continue;
    }
    if (role === 'assistant') {
      const names = toolNames(entry.message?.content);
      if (names.length === 0 || names.some((name) => name !== DISCARD))
        return `${DISCARD} must be the only tool call since the delivery; this turn already did other work.`;
      plan.run.unshift(entry.id);
      continue;
    }
    return NOT_DELIVERY;
  }
  return plan.triggers.length > 0 ? plan : NOT_DELIVERY;
}

export function turnDiscardEdits(plan: DiscardPlan, reason: string) {
  return [
    ...plan.triggers.map((targetId) => ({
      type: 'context_edit' as const,
      targetId,
      replacement: {
        content: `[Discarded delivery ${targetId}: ${reason}] Original hidden from context; call ${RECALL} with this id if needed.`,
      },
    })),
    ...plan.run.map((targetId) => ({
      type: 'context_edit' as const,
      targetId,
      replacement: null,
    })),
  ];
}

/** 只取回已被丢弃的插件投递原文，不做通用条目读取 */
export function recallDiscarded(branch: readonly BranchEntry[], id: string): string {
  const entry = branch.find((item) => item.id === id);
  const discarded =
    entry?.type === 'custom_message' &&
    entry.customType === PLUGIN_MESSAGE_TYPE &&
    branch.some((item) => item.type === 'context_edit' && item.targetId === id);
  if (!discarded) throw new Error(`No discarded delivery with id ${id}.`);
  const content = entry!.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'text' ? String(part.text ?? '') : `[${part?.type ?? 'part'}]`))
    .join('\n');
}

function discardReason(message: unknown, toolResults: readonly unknown[]): string | undefined {
  const content = (message as { role?: string; content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (part?.type !== 'toolCall' || part.name !== DISCARD) continue;
    const ok = toolResults.some(
      (r) =>
        (r as { toolCallId?: string }).toolCallId === part.id &&
        (r as { isError?: boolean }).isError !== true
    );
    if (ok) return String(part.arguments?.reason ?? '').trim();
  }
  return undefined;
}

/** turn_discard 成功的轮次结束时写入 context_edit；时间线与 jsonl 原文不变 */
export function turnDiscardExtension(): InlineExtension {
  return {
    name: 'turn-discard',
    hidden: true,
    factory: (pi) => {
      pi.on('turn_end', (event, ctx) => {
        const reason = discardReason(event.message, event.toolResults);
        if (reason === undefined) return;
        const plan = planTurnDiscard(ctx.sessionManager.getBranch() as unknown as BranchEntry[]);
        if (typeof plan === 'string') return;
        return { entries: [...event.entries, ...turnDiscardEdits(plan, reason)] };
      });
    },
  };
}

const text = (value: string) => [{ type: 'text' as const, text: value }];

export function createTurnDiscardTools(): ToolDefinition[] {
  return [
    {
      name: DISCARD,
      label: 'Turn discard',
      description:
        'Discard the current turn when an automatic plugin delivery (e.g. Telegram watch, scheduler) needs no action. Must be the only tool call since the delivery; never after sending messages or changing anything. Ends the turn immediately; later context keeps only a one-line trace with an id for turn_recall. The timeline keeps everything.',
      promptSnippet:
        'turn_discard: drop an irrelevant automatic delivery from context instead of replying "skip".',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'One short line: why it needs no action' },
        },
        required: ['reason'],
      } as unknown as ToolDefinition['parameters'],
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const reason = String((params as { reason?: string }).reason ?? '').trim();
        if (!reason) throw new Error('reason is required');
        const plan = planTurnDiscard(ctx.sessionManager.getBranch() as unknown as BranchEntry[]);
        if (typeof plan === 'string') throw new Error(plan);
        return {
          content: text(`Turn discarded: ${reason}`),
          details: { reason, triggers: plan.triggers },
          terminate: true,
        };
      },
    },
    {
      name: RECALL,
      label: 'Turn recall',
      description: 'Read the original content of a delivery previously removed by turn_discard.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Id shown in the discard trace' } },
        required: ['id'],
      } as unknown as ToolDefinition['parameters'],
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const id = String((params as { id?: string }).id ?? '').trim();
        const branch = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
        return { content: text(recallDiscarded(branch, id)), details: undefined };
      },
    },
  ];
}
