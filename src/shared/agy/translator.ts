import { ensoProxiedTool, isEnsoMcpCardName } from './hostTools';
import { cardArgs, toolNameFromUpdate } from './tools';
import type {
  AgyContextUsage,
  AgyPlanItem,
  AgyToolCard,
  AgyToolStatus,
  PiStopReason,
  TranslatorEffect,
  TranslatorState,
} from './types';

export function emptyTranslatorState(): TranslatorState {
  return { text: '', thinking: '', tools: [], plan: null };
}

const SUBAGENT_TOOLS = new Set(['start_subagent', 'invoke_subagent']);

/**
 * 这个工具会不会在 end_turn 之后继续跑（t3 antigravityCommandOutlivesPrompt、paseo deferTurnOnRunningTools）。
 * daemon 命令可能永远不结束，定时唤醒（schedule）由 agy 自己另起回复，都不留住本轮。
 * 只有带 kind / rawInput 的 update 才判定；后续只报状态的 update 沿用。
 */
function outlivesPrompt(update: Record<string, unknown>, name: string): boolean | undefined {
  const raw = record(update.rawInput);
  if (update.kind === undefined && !raw) return undefined;
  if (name === 'schedule') return false;
  if (SUBAGENT_TOOLS.has(name)) return true;
  if (update.kind !== 'execute' && name !== 'run_command') return false;
  return raw?.IsDaemon !== true;
}

/** end_turn 时这些工具还没跑完：本轮留着，等 agy 自己接着回复 */
export function holdsTurn(tools: readonly AgyToolCard[]): boolean {
  return tools.some(
    (tool) =>
      tool.background === true && (tool.status === 'in_progress' || tool.status === 'pending')
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(update: Record<string, unknown>): string {
  const content = record(update.content);
  if (content && typeof content.text === 'string') return content.text;
  return typeof update.text === 'string' ? update.text : '';
}

function statusOf(value: unknown): AgyToolStatus {
  if (
    value === 'pending' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'failed'
  ) {
    return value;
  }
  return 'pending';
}

function readPath(update: Record<string, unknown>): string | undefined {
  const locations = update.locations;
  if (Array.isArray(locations)) {
    const first = record(locations[0]);
    if (first && typeof first.path === 'string') return first.path;
  }
  const raw = record(update.rawInput);
  if (!raw) return undefined;
  for (const key of ['absolute_path', 'path']) {
    if (typeof raw[key] === 'string') return raw[key];
  }
  return undefined;
}

function argsOf(update: Record<string, unknown>): Record<string, unknown> {
  const { toolSummary: _summary, ...args } = record(update.rawInput) ?? record(update.args) ?? {};
  return args;
}

/** agy 1.5.18 的 rawOutput 是 `{ output, exit_code }`；旧形状是字符串，再退到 content 文字。 */
function outputText(update: Record<string, unknown>): string | undefined {
  if (typeof update.rawOutput === 'string') return update.rawOutput;
  const raw = record(update.rawOutput);
  if (typeof raw?.output === 'string') return raw.output;
  if (!Array.isArray(update.content)) return undefined;
  const texts: string[] = [];
  for (const entry of update.content) {
    const block = record(entry);
    if (block?.type !== 'content') continue;
    const content = record(block.content);
    if (content?.type === 'text' && typeof content.text === 'string') texts.push(content.text);
  }
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function repairStatus(
  update: Record<string, unknown>,
  name: string,
  status: AgyToolStatus,
  servedReads: readonly string[],
  previous: AgyToolCard | undefined
): AgyToolStatus {
  if (status !== 'failed' || name !== 'read_file') return status;
  const target = readPath(update) ?? pathOfArgs(previous?.args);
  return target && servedReads.includes(target) ? 'completed' : status;
}

function pathOfArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ['absolute_path', 'path']) {
    if (typeof args[key] === 'string') return args[key];
  }
  return undefined;
}

function upsertTool(state: TranslatorState, card: AgyToolCard): TranslatorState {
  const index = state.tools.findIndex((tool) => tool.id === card.id);
  const tools = [...state.tools];
  if (index >= 0)
    tools[index] = { ...tools[index], ...card, args: { ...tools[index]?.args, ...card.args } };
  else tools.push(card);
  return { ...state, tools };
}

export function reduceAgyUpdate(
  state: TranslatorState,
  update: unknown,
  servedReads: readonly string[] = []
): { state: TranslatorState; effects: TranslatorEffect[] } {
  const recordUpdate = record(update);
  if (!recordUpdate) return { state, effects: [] };
  const kind = recordUpdate.sessionUpdate;
  if (kind === 'agent_message_chunk') {
    const delta = textOf(recordUpdate);
    if (!delta) return { state, effects: [] };
    return { state: { ...state, text: state.text + delta }, effects: [{ type: 'text', delta }] };
  }
  if (kind === 'agent_thought_chunk') {
    const delta = textOf(recordUpdate);
    if (!delta) return { state, effects: [] };
    return {
      state: { ...state, thinking: state.thinking + delta },
      effects: [{ type: 'thinking', delta }],
    };
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const id = typeof recordUpdate.toolCallId === 'string' ? recordUpdate.toolCallId : '';
    if (!id) return { state, effects: [] };
    const name = toolNameFromUpdate({
      name: typeof recordUpdate.name === 'string' ? recordUpdate.name : undefined,
      title: typeof recordUpdate.title === 'string' ? recordUpdate.title : undefined,
      rawInput: recordUpdate.rawInput,
    });
    // 我们自己的 Host MCP 工具（直调或经 call_mcp_tool 转调）由 Enso 画卡，agy 这一侧的卡丢掉
    if (state.hidden?.includes(id)) return { state, effects: [] };
    const proxied = ensoProxiedTool({
      name: typeof recordUpdate.name === 'string' ? recordUpdate.name : undefined,
      title: typeof recordUpdate.title === 'string' ? recordUpdate.title : undefined,
      rawInput: recordUpdate.rawInput,
    });
    if (isEnsoMcpCardName(name) || proxied) {
      return { state: { ...state, hidden: [...(state.hidden ?? []), id] }, effects: [] };
    }
    const previous = state.tools.find((tool) => tool.id === id);
    const resolvedName = name === 'tool' && previous ? previous.name : name;
    const status = repairStatus(
      recordUpdate,
      resolvedName,
      statusOf(recordUpdate.status),
      servedReads,
      previous
    );
    const background = previous?.background ?? outlivesPrompt(recordUpdate, resolvedName);
    const card: AgyToolCard = {
      id,
      name: resolvedName,
      status,
      args: cardArgs(resolvedName, argsOf(recordUpdate)),
      ...(outputText(recordUpdate) !== undefined ? { output: outputText(recordUpdate) } : {}),
      ...(typeof recordUpdate.title === 'string' ? { title: recordUpdate.title } : {}),
      ...(background !== undefined ? { background } : {}),
    };
    return {
      state: upsertTool(state, card),
      effects: [
        {
          type: 'tool',
          id,
          name: resolvedName,
          status,
          args: card.args,
          ...(card.output !== undefined ? { output: card.output } : {}),
        },
      ],
    };
  }
  if (kind === 'plan' && Array.isArray(recordUpdate.entries)) {
    const items: AgyPlanItem[] = [];
    for (const entry of recordUpdate.entries) {
      const row = record(entry);
      if (!row || typeof row.content !== 'string') continue;
      items.push({
        content: row.content,
        ...(typeof row.status === 'string' ? { status: row.status } : {}),
      });
    }
    return { state: { ...state, plan: items }, effects: [{ type: 'plan', items }] };
  }
  if (kind === 'usage_update') {
    const context = contextOf(recordUpdate);
    return { state: context ? { ...state, context } : state, effects: [] };
  }
  return { state, effects: [] };
}

/** usage_update 的 used 是 agy 当前上下文占用，size 是它的窗口；坏值不记 */
function contextOf(update: Record<string, unknown>): AgyContextUsage | undefined {
  const { used, size } = update;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return undefined;
  const validSize = typeof size === 'number' && Number.isFinite(size) && size > 0;
  return validSize ? { used, size } : { used };
}

/** agy `stopReason` → pi。end_turn 正常，max_tokens 中断，取消单独标，其余失败。 */
export function stopFromPrompt(stopReason: unknown): PiStopReason {
  if (stopReason === 'end_turn') return 'stop';
  if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') return 'length';
  if (stopReason === 'cancelled' || stopReason === 'canceled') return 'aborted';
  return 'error';
}
