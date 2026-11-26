import { toolNameFromUpdate } from './tools';
import type {
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
  return record(update.rawInput) ?? {};
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
      title: typeof recordUpdate.title === 'string' ? recordUpdate.title : undefined,
      rawInput: recordUpdate.rawInput,
    });
    const previous = state.tools.find((tool) => tool.id === id);
    const resolvedName = name === 'tool' && previous ? previous.name : name;
    const status = repairStatus(
      recordUpdate,
      resolvedName,
      statusOf(recordUpdate.status),
      servedReads,
      previous
    );
    const card: AgyToolCard = {
      id,
      name: resolvedName,
      status,
      args: argsOf(recordUpdate),
      ...(typeof recordUpdate.title === 'string' ? { title: recordUpdate.title } : {}),
    };
    return {
      state: upsertTool(state, card),
      effects: [{ type: 'tool', id, name, status, args: card.args }],
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
  return { state, effects: [] };
}

/** agy `stopReason` → pi。end_turn 正常，max_tokens 中断，取消单独标，其余失败。 */
export function stopFromPrompt(stopReason: unknown): PiStopReason {
  if (stopReason === 'end_turn') return 'stop';
  if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') return 'length';
  if (stopReason === 'cancelled' || stopReason === 'canceled') return 'aborted';
  return 'error';
}
