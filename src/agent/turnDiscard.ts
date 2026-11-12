import type { InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { PLUGIN_MESSAGE_TYPE } from '@shared/extensionPlugins/protocol';
import { isReadOnlyCommand } from '@shared/readOnlyCommand';

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
  /** 触发本轮的插件投递或用户消息条目 */
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

const REASON_MAX = 300;

const NO_TRIGGER = `${DISCARD} found no user message or plugin delivery that started this turn.`;

/** 不改动环境的内置工具；其余工具看 readOnlyHint，bash 看命令 */
const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'glob',
  'web_search',
  'web_fetch',
  'memory_search',
  'recall',
  'task_output',
  'browser_snapshot',
  'browser_screenshot',
  RECALL,
]);

export function readOnlyCall(name: string, args: unknown, annotated: ReadonlySet<string>): boolean {
  if (READ_ONLY_TOOLS.has(name) || annotated.has(name)) return true;
  const { command, background } = (args ?? {}) as { command?: unknown; background?: unknown };
  return (
    name === 'bash' &&
    typeof command === 'string' &&
    background !== true &&
    isReadOnlyCommand(command)
  );
}

type ReadOnly = (name: string, args: unknown) => boolean;

function toolCalls(content: unknown): { name: string; args: unknown }[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    part?.type === 'toolCall' && typeof part.name === 'string'
      ? [{ name: part.name, args: part.arguments }]
      : []
  );
}

function isTrigger(entry: BranchEntry): boolean {
  return entry.type === 'custom_message'
    ? entry.customType === PLUGIN_MESSAGE_TYPE
    : entry.type === 'message' && entry.message?.role === 'user';
}

/** 从分支末尾回溯本轮：由用户消息或插件投递触发，且本轮除 turn_discard 外只调用过只读工具 */
export function planTurnDiscard(
  branch: readonly BranchEntry[],
  readOnly: ReadOnly = () => false
): DiscardPlan | string {
  const plan: DiscardPlan = { triggers: [], run: [] };
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (PASSIVE.has(entry.type)) continue;
    if (isTrigger(entry)) {
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
      const calls = toolCalls(entry.message?.content);
      if (calls.length === 0) return NO_TRIGGER;
      const changed = calls.find((c) => c.name !== DISCARD && !readOnly(c.name, c.args));
      if (changed)
        return `${DISCARD} cannot drop a turn that may have changed something (${changed.name}); only read-only tools are allowed before it.`;
      plan.run.unshift(entry.id);
      continue;
    }
    return NO_TRIGGER;
  }
  return plan.triggers.length > 0 ? plan : NO_TRIGGER;
}

export function turnDiscardEdits(plan: DiscardPlan, reason: string) {
  return [
    ...plan.triggers.map((targetId) => ({
      type: 'context_edit' as const,
      targetId,
      replacement: {
        content: `[Discarded turn input ${targetId}${reason ? `: ${reason}` : ''}] Original hidden from context; call ${RECALL} with this id if needed.`,
      },
    })),
    ...plan.run.map((targetId) => ({
      type: 'context_edit' as const,
      targetId,
      replacement: null,
    })),
  ];
}

/** 只取回已被丢弃的触发条目（插件投递 / 用户消息）原文，不做通用条目读取 */
export function recallDiscarded(branch: readonly BranchEntry[], id: string): string {
  const entry = branch.find((item) => item.id === id);
  const discarded =
    entry !== undefined &&
    isTrigger(entry) &&
    branch.some((item) => item.type === 'context_edit' && item.targetId === id);
  if (!discarded) throw new Error(`No discarded turn input with id ${id}.`);
  const content = entry.type === 'message' ? entry.message?.content : entry.content;
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

/** 扩展与工具共享：工具执行时要按当前工具注解判断只读 */
export function createTurnDiscardState() {
  return {
    readOnly: ((name: string, args: unknown) => readOnlyCall(name, args, new Set())) as ReadOnly,
  };
}
export type TurnDiscardState = ReturnType<typeof createTurnDiscardState>;

/** turn_discard 成功的轮次结束时写入 context_edit；时间线与 jsonl 原文不变 */
export function turnDiscardExtension(state: TurnDiscardState): InlineExtension {
  return {
    name: 'turn-discard',
    hidden: true,
    factory: (pi) => {
      state.readOnly = (name, args) =>
        readOnlyCall(
          name,
          args,
          new Set(
            pi
              .getAllTools()
              .filter((tool) => tool.annotations?.readOnlyHint === true)
              .map((tool) => tool.name)
          )
        );
      pi.on('turn_end', (event, ctx) => {
        const reason = discardReason(event.message, event.toolResults);
        if (reason === undefined) return;
        const plan = planTurnDiscard(
          ctx.sessionManager.getBranch() as unknown as BranchEntry[],
          state.readOnly
        );
        if (typeof plan === 'string') return;
        return { entries: [...event.entries, ...turnDiscardEdits(plan, reason)] };
      });
    },
  };
}

const text = (value: string) => [{ type: 'text' as const, text: value }];

export function createTurnDiscardTools(state: TurnDiscardState): ToolDefinition[] {
  return [
    {
      name: DISCARD,
      label: 'Turn discard',
      description:
        'Drop the current turn from your context when nothing in it needs to be remembered: an automatic plugin delivery (Telegram watch, scheduler) that needs no action, or a throwaway user question once answered (answer in the same message, then call this). Allowed only if this turn used read-only tools (read, grep, find, ls, web, read-only bash...); never after editing files, sending messages, or any other change. Ends the turn immediately; later context keeps only a one-line trace with an id for turn_recall. The timeline keeps everything.',
      promptSnippet:
        'turn_discard: drop an irrelevant automatic delivery or a throwaway exchange from context instead of replying "skip".',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: `Optional, one line (max ${REASON_MAX} chars): what this was and why it needs nothing; add any conclusion from your read-only checks worth remembering. Stays in later context.`,
          },
        },
      } as unknown as ToolDefinition['parameters'],
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const reason = String((params as { reason?: string }).reason ?? '').trim();
        if (reason.length > REASON_MAX)
          throw new Error(
            `reason is longer than ${REASON_MAX} characters; shorten it to one line.`
          );
        const plan = planTurnDiscard(
          ctx.sessionManager.getBranch() as unknown as BranchEntry[],
          state.readOnly
        );
        if (typeof plan === 'string') throw new Error(plan);
        return {
          content: text(reason ? `Turn discarded: ${reason}` : 'Turn discarded.'),
          details: { reason, triggers: plan.triggers },
          terminate: true,
        };
      },
    },
    {
      name: RECALL,
      label: 'Turn recall',
      description:
        'Read the original content of a delivery or user message previously removed by turn_discard.',
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
