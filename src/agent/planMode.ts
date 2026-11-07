import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { normalizeComputerParams } from '@shared/computer/params';
import {
  activePlanNote,
  foldPlanState,
  PLAN_ENTRY_TYPE,
  PLAN_MODE_OFF_NOTE,
  PLAN_MODE_ON_NOTE,
  PLAN_TEXT_MAX,
  PLAN_TITLE_MAX,
  type PlanDoc,
  type PlanEntry,
  type PlanRespondAction,
  type PlanState,
  parsePlanEntry,
  planFeedbackText,
  planKickoffText,
  planPhase,
} from '@shared/planMode';

export interface PlanHost {
  state(): PlanState;
  submit(doc: PlanDoc): void;
}

/**
 * worker 侧 Plan 状态机：jsonl 条目是权威，内存只缓存折叠结果与「待告知模型」的一条提示。
 * 提示只追加（前缀到下一条用户消息或下一次工具结果），从不改写历史。
 */
export class PlanController implements PlanHost {
  private current!: PlanState;
  private note: string | undefined;
  /** 模型当前是否被告知处于 Plan 模式，用于避免多余的开/关提示 */
  private modelKnowsPlan = false;

  constructor(
    private readonly store: { branch(): readonly unknown[]; append(entry: PlanEntry): void },
    private readonly onChange: (state: PlanState) => void
  ) {
    this.sync();
  }

  state(): PlanState {
    return this.current;
  }

  /** 回退 / 分支切换后按当前分支重新折叠 */
  refresh(): void {
    this.sync();
    this.onChange(this.current);
  }

  /** 冷恢复 / 回退后无法确认模型上下文里还有规则，处于规划中就重申一次 */
  private sync(): void {
    this.current = foldPlanState(this.store.branch());
    this.modelKnowsPlan = restricting(this.current);
    this.note = this.modelKnowsPlan ? PLAN_MODE_ON_NOTE : undefined;
  }

  setActive(active: boolean): void {
    if (this.current.active !== active) {
      this.append({ v: 1, kind: 'mode', active, at: Date.now() });
      this.note =
        active === this.modelKnowsPlan
          ? undefined
          : active
            ? PLAN_MODE_ON_NOTE
            : PLAN_MODE_OFF_NOTE;
    }
    this.onChange(this.current);
  }

  submit(doc: PlanDoc): void {
    this.append({ v: 1, kind: 'submitted', ...doc, at: Date.now() });
    this.onChange(this.current);
  }

  /** 用户在待审期间直接发消息：继续规划，旧计划作废 */
  supersede(): void {
    const pending = this.current.pending;
    if (!pending) return;
    this.append({
      v: 1,
      kind: 'resolved',
      planId: pending.planId,
      action: 'superseded',
      at: Date.now(),
    });
    this.onChange(this.current);
  }

  /** 审批决策；planId 过期返回 null。返回的 prompt 由调用方作为新一轮用户消息发出 */
  respond(planId: string, action: PlanRespondAction, feedback = ''): { prompt?: string } | null {
    const { pending, executing } = this.current;
    if (action === 'finish') {
      if (executing?.planId !== planId) return null;
      this.append({ v: 1, kind: 'finished', planId, at: Date.now() });
      this.onChange(this.current);
      return {};
    }
    if (pending?.planId !== planId) return null;
    if (action === 'revise' && !feedback.trim()) return null;
    if (action === 'discard') {
      this.setActive(false);
      return {};
    }
    this.append({
      v: 1,
      kind: 'resolved',
      planId,
      action: action === 'approve' ? 'approved' : 'revised',
      at: Date.now(),
    });
    this.onChange(this.current);
    if (action === 'revise') return { prompt: planFeedbackText(planId, feedback.trim()) };
    // 批准消息本身宣告 Plan 结束
    this.modelKnowsPlan = false;
    this.note = undefined;
    return { prompt: planKickoffText(pending) };
  }

  /** 压缩后上下文可能丢了规则或计划，下一次机会补一次 */
  compacted(): void {
    if (restricting(this.current)) this.note = PLAN_MODE_ON_NOTE;
    else if (this.current.executing) this.note = activePlanNote(this.current.executing);
  }

  /** 轮次正常收尾：执行态下批准后建过 todo 且最新清单全部完成，自动结束执行态 */
  turnSettled(): void {
    const executing = this.current.executing;
    if (!executing || !executionDone(this.store.branch(), executing.planId)) return;
    this.append({ v: 1, kind: 'finished', planId: executing.planId, at: Date.now() });
    this.onChange(this.current);
  }

  takeNote(): string | undefined {
    const note = this.note;
    this.note = undefined;
    if (note === PLAN_MODE_ON_NOTE) this.modelKnowsPlan = true;
    else if (note === PLAN_MODE_OFF_NOTE) this.modelKnowsPlan = false;
    return note;
  }

  private append(entry: PlanEntry): void {
    this.store.append(entry);
    this.current = foldPlanState(this.store.branch());
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function executionDone(entries: readonly unknown[], planId: string): boolean {
  const start = entries.findLastIndex((raw) => {
    if (!isRecord(raw) || raw.type !== 'custom' || raw.customType !== PLAN_ENTRY_TYPE) return false;
    const entry = parsePlanEntry(raw.data);
    return entry?.kind === 'resolved' && entry.planId === planId && entry.action === 'approved';
  });
  if (start < 0) return false;
  let sawItems = false;
  let done = false;
  let interrupted = false;
  for (const raw of entries.slice(start + 1)) {
    const message = isRecord(raw) && raw.type === 'message' ? raw.message : undefined;
    if (!isRecord(message)) continue;
    if (message.role === 'assistant') {
      interrupted = message.stopReason === 'aborted' || message.stopReason === 'error';
    } else if (
      message.role === 'toolResult' &&
      message.toolName === 'todo' &&
      !message.isError &&
      isRecord(message.details) &&
      Array.isArray(message.details.todos)
    ) {
      const todos: unknown[] = message.details.todos;
      sawItems ||= todos.length > 0;
      done = todos.every((item) => isRecord(item) && item.status === 'completed');
    }
  }
  return sawItems && done && !interrupted;
}

const DENIED_TOOLS = new Set(['edit', 'write', 'apply_patch', 'todo', 'workflow', 'ImageGen']);
const SUBAGENT_PASSIVE_OPS = new Set(['wait', 'report', 'list', 'stop', 'dismiss']);

const denied = (reason: string) =>
  new Error(
    `Plan mode is active: ${reason}. Keep researching read-only and call submit_plan when the plan is ready.`
  );

const restricting = (state: PlanState) => {
  const phase = planPhase(state);
  return phase === 'planning' || phase === 'awaiting_review';
};

/**
 * Plan 工具门：包在父会话工具定义最外层（exec 沙盒内层调用同样经过），工具目录保持不变。
 * 写工具硬拒；subagent 只能派生只读类型；bash / MCP 仍按当前审批档走内层 withApproval。
 */
export function withPlanGate(
  definition: ToolDefinition,
  deps: { host: PlanHost; readonlyAgentTypes: ReadonlySet<string> }
): ToolDefinition {
  const { host, readonlyAgentTypes } = deps;
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!restricting(host.state()))
        return definition.execute(toolCallId, params, signal, onUpdate, ctx);
      const record = (params ?? {}) as Record<string, unknown>;
      const name = definition.name;
      if (DENIED_TOOLS.has(name)) throw denied(`${name} is disabled while planning`);
      if (name === 'computer' && normalizeComputerParams(params)?.readOnly !== true) {
        throw denied('computer only runs with read_only: true while planning');
      }
      if (name === 'subagent') {
        const operation = record.operation;
        if (operation === 'spawn') {
          const type = typeof record.agent_type === 'string' ? record.agent_type : '';
          if (!readonlyAgentTypes.has(type))
            throw denied(
              `spawn requires a read-only agent_type (${[...readonlyAgentTypes].join(', ') || 'none available'})`
            );
        } else if (!SUBAGENT_PASSIVE_OPS.has(String(operation))) {
          throw denied(`subagent ${String(operation)} is disabled while planning`);
        }
      }
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

const PARAMETERS = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: `Short plan title (max ${PLAN_TITLE_MAX} characters)`,
    },
    plan: {
      type: 'string',
      description: 'The complete implementation plan in Markdown',
    },
  },
  required: ['title', 'plan'],
} as unknown as ToolDefinition['parameters'];

export function createSubmitPlanTool(host: PlanHost, newId: () => string): ToolDefinition {
  return {
    name: 'submit_plan',
    label: 'Submit plan',
    description:
      'Plan mode only: submit the complete implementation plan for user review. ' +
      'Call it as the only and final tool call of the response; the turn ends and the user approves or requests changes.',
    promptSnippet: 'submit_plan: plan mode only — submit the finished plan for user review',
    parameters: PARAMETERS,
    async execute(_toolCallId, params) {
      const record = (params ?? {}) as Record<string, unknown>;
      const state = host.state();
      if (!state.active)
        throw new Error(
          'Plan mode is not active. Only call submit_plan after the user enables plan mode.'
        );
      if (state.pending)
        throw new Error('A plan is already awaiting review. Stop and wait for the user.');
      const title = typeof record.title === 'string' ? record.title.trim() : '';
      const text = typeof record.plan === 'string' ? record.plan.trim() : '';
      if (!title || title.length > PLAN_TITLE_MAX)
        throw new Error(`title must be 1-${PLAN_TITLE_MAX} characters`);
      if (!text || text.length > PLAN_TEXT_MAX)
        throw new Error(`plan must be non-empty Markdown up to ${PLAN_TEXT_MAX} characters`);
      const doc = { planId: newId(), title, text };
      host.submit(doc);
      return {
        content: [
          { type: 'text' as const, text: 'Plan submitted for user review. Stop here and wait.' },
        ],
        details: { planId: doc.planId, title },
        terminate: true,
      };
    },
  };
}
