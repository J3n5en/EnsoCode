import { SECRETARY_OPS } from '@shared/secretary/tools';
import { parseMemoryCapture, parseMemorySearchHits } from '@/components/chat/memorySearchHits';
import { parseMcpToolName } from '@/lib/mcpToolName';
import { parseImageViewFacts } from '@/lib/toolImage';
import { TOOL_LABEL_KEYS } from '@/lib/toolLabels';
import { cronPhrase, displayLabel, formatStamp, shortId } from './phrase';
import type {
  ToolCallInput,
  ToolCardBlock,
  ToolCardContext,
  ToolCardPresentation,
  ToolCardState,
  ToolCardStatus,
  ToolCardView,
} from './types';

const CARD_TOOLS = new Set<string>([
  ...SECRETARY_OPS,
  'memory_search',
  'memory_capture',
  'memory_delete',
  'memory_crystallize',
  'web_search',
  'web_fetch',
]);

/**
 * 可读卡片只属于秘书会话，普通会话一律走原来的工具行。
 * 会话类型由调用方显式传入，不看工具名前缀。
 */
export function usesToolCard(name: string, secretarySession = false): boolean {
  // 后台任务收尾表态在任何会话里都是一张可读卡片：逐条列出停了什么、留了什么
  if (name === 'task_settle') return true;
  if (!secretarySession) return false;
  return CARD_TOOLS.has(name) || name.startsWith('my_') || parseMcpToolName(name) !== null;
}

type Renderer = (call: ToolCallInput, ctx: ToolCardContext) => ToolCardView;

const registry = new Map<string, Renderer>();

function register(name: string, renderer: Renderer): void {
  registry.set(name, renderer);
}

export function renderToolCall(call: ToolCallInput, ctx: ToolCardContext): ToolCardView {
  return (registry.get(call.name) ?? genericRenderer)(call, ctx);
}

const GROUP_TITLES: Record<string, string> = {
  todo_item_update: 'Updated {{count}} to-dos',
  todo_item_add: 'Added {{count}} to-dos',
  session_send: 'Sent {{count}} messages',
  session_stop: 'Stopped {{count}} sessions',
  session_task_stop: 'Stopped {{count}} background tasks',
  session_archive: 'Archived {{count}} sessions',
  session_unarchive: 'Unarchived {{count}} sessions',
  result_mark_done: 'Marked {{count}} sessions done',
  result_mark_undo: 'Undid {{count}} marks',
  needs_user_escalate: 'Escalated {{count}} items to you',
  session_answer: 'Answered {{count}} questions',
  session_create: 'Created {{count}} sessions',
  todo_item_dispatch: 'Dispatched {{count}} to-dos',
  schedule_add: 'Added {{count}} schedules',
  schedule_remove: 'Removed {{count}} schedules',
};

export function presentToolCalls(
  calls: readonly ToolCallInput[],
  ctx: ToolCardContext
): ToolCardPresentation {
  const cards = calls.map((call) => renderToolCall(call, ctx));
  if (cards.length <= 1) return { grouped: false, title: cards[0]?.title ?? '', cards };
  const name = calls[0]?.name ?? '';
  const key = GROUP_TITLES[name];
  const title = key
    ? ctx.t(key, { count: cards.length })
    : ctx.t('{{count}} × {{tool}}', { count: cards.length, tool: friendlyName(name, ctx) });
  return { grouped: true, title, cards };
}

/** 卡片上看得见的字，不含折叠的原始 JSON */
export function cardPlainText(card: ToolCardView): string {
  const parts = [card.title, card.status?.label ?? ''];
  for (const block of card.blocks) {
    if (
      block.kind === 'markdown' ||
      block.kind === 'note' ||
      block.kind === 'error' ||
      block.kind === 'prompt'
    )
      parts.push(block.text);
    else if (block.kind === 'session') parts.push(block.label);
    else if (block.kind === 'kv' || block.kind === 'diff') {
      for (const row of block.rows)
        parts.push(
          row.label,
          'before' in row ? row.before : row.value,
          'after' in row ? row.after : ''
        );
    } else if (block.kind === 'list') {
      for (const item of block.items) parts.push(item.title, item.badge ?? '', item.detail ?? '');
    }
  }
  return parts.filter(Boolean).join('\n');
}

function friendlyName(name: string, ctx: ToolCardContext): string {
  if (name.startsWith('my_')) {
    return ctx.t('Custom tool {{name}}', { name: name.slice(3).replaceAll('-', ' ') });
  }
  const mcp = parseMcpToolName(name);
  if (mcp) return `${mcp.tool.replaceAll('_', ' ')} · ${mcp.server}`;
  const key = TOOL_LABEL_KEYS[name];
  return key ? ctx.t(key) : name.replaceAll('_', ' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rec(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 工具结果可能是「单行 JSON + <source_reference> 行」（带 path 参数的工具会被追加一行），
 * 整段解析失败时退回只解析第一行。
 */
function parseJsonLine(text: string | null): unknown {
  const whole = parseJson(text);
  if (whole !== null) return whole;
  return parseJson(text?.split('\n', 1)[0] ?? null);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function plainUntrusted(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  const match = raw.match(/^<untrusted-content\b[^>]*>([\s\S]*)<\/untrusted-content>$/u);
  return (match ? match[1] : raw).trim() || undefined;
}

function longText(text: string): boolean {
  return text.length > 280 || text.split('\n').length > 6;
}

function rawOf(call: ToolCallInput): { rawArgs: string; rawOutput: string } {
  let rawArgs = '';
  try {
    rawArgs =
      typeof call.args === 'string' ? call.args : (JSON.stringify(call.args, null, 2) ?? '');
  } catch {
    rawArgs = String(call.args);
  }
  return { rawArgs, rawOutput: call.output ?? '' };
}

function view(
  call: ToolCallInput,
  title: string,
  blocks: ToolCardBlock[],
  status?: ToolCardStatus
): ToolCardView {
  return {
    name: call.name,
    title,
    state: call.state,
    blocks,
    ...(status ? { status } : {}),
    ...rawOf(call),
  };
}

const REASONS: Record<string, string> = {
  'dispatch-limit': 'Dispatch limit reached',
  'project-not-visible': 'Project is not visible',
  'project-required': 'A project is required',
  'not-found': 'Not found',
  'invalid-cron': 'Invalid schedule',
  'invalid-at': 'Invalid schedule',
  'at-in-past': 'Invalid schedule',
  'exactly-one-of-at-or-cron': 'Invalid schedule',
  'stale-index':
    'The message changed (the session was rewound or switched branches). List the session again and read it with the new id.',
  'not-readable':
    'Only user and assistant messages can be read; tool calls and tool output are not shown.',
};

function errorText(call: ToolCallInput, ctx: ToolCardContext): string | null {
  if (call.state !== 'error') return null;
  const text = call.output?.trim() ?? '';
  if (!text) return ctx.t('Tool failed');
  // 错误可能是「码: 说明」，按码取译文
  const key = REASONS[text] ?? REASONS[/^([a-z][a-z-]*):\s/u.exec(text)?.[1] ?? ''];
  return key ? ctx.t(key) : text;
}

function sessionLabel(id: string | undefined, ctx: ToolCardContext): string {
  if (!id) return ctx.t('Unknown session');
  return displayLabel(id, ctx.lookup?.sessionTitle?.(id));
}

function projectLabel(id: string | undefined, ctx: ToolCardContext): string {
  if (!id) return ctx.t('Not set');
  return displayLabel(id, ctx.lookup?.projectName?.(id));
}

function showValue(value: unknown, ctx: ToolCardContext): string {
  if (value === null || value === undefined || value === '') return ctx.t('Not set');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function kvRows(
  record: Record<string, unknown>,
  ctx: ToolCardContext
): { label: string; value: string }[] {
  return Object.entries(record).map(([label, value]) => ({ label, value: showValue(value, ctx) }));
}

const STATE_KEYS: Record<string, { key: string; tone: ToolCardStatus['tone'] }> = {
  running: { key: 'Session running', tone: 'ok' },
  idle: { key: 'Session idle', tone: 'neutral' },
  waiting: { key: 'Session needs you', tone: 'pending' },
  error: { key: 'Session error', tone: 'error' },
  'not-started': { key: 'Session not started', tone: 'neutral' },
};

function stateBadge(
  state: unknown,
  ctx: ToolCardContext
): { badge: string; badgeTone: ToolCardStatus['tone'] } {
  const known = typeof state === 'string' ? STATE_KEYS[state] : undefined;
  if (!known) return { badge: typeof state === 'string' ? state : '', badgeTone: 'neutral' };
  return { badge: ctx.t(known.key), badgeTone: known.tone };
}

function pendingCount(value: unknown): number {
  const pending = rec(value);
  const approvals = typeof pending?.approvals === 'number' ? pending.approvals : 0;
  const asks = typeof pending?.asks === 'number' ? pending.asks : 0;
  return approvals + asks;
}

function unwrap(text: string): string {
  return text
    .replace(/<untrusted-content[^>]*>/gu, '')
    .replace(/<\/untrusted-content>/gu, '')
    .trim();
}

function firstLine(text: string): string {
  const line =
    unwrap(text)
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean) ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

const CARD_KIND: Record<string, string> = {
  dispatch: 'Dispatch card',
  profile: 'Profile card',
  skill: 'Skill card',
  tool: 'Tool card',
  takeover: 'Takeover card',
  cleanup: 'Cleanup card',
};

function confirmation(
  output: Record<string, unknown> | null,
  ctx: ToolCardContext
): ToolCardStatus | undefined {
  if (output?.status !== 'awaiting_confirmation') return undefined;
  const id = str(output.proposalId) ?? '';
  const proposal = id ? ctx.lookup?.proposal?.(id) : undefined;
  const status = proposal?.status ?? 'pending';
  const card = ctx.t(CARD_KIND[proposal?.kind ?? ''] ?? 'Confirmation card');
  if (status === 'pending' || status === 'executing') {
    return {
      tone: 'pending',
      label: ctx.t('Waiting on {{card}} {{id}}', { card, id: id ? shortId(id) : ctx.t('Not set') }),
    };
  }
  if (status === 'succeeded') return { tone: 'ok', label: ctx.t('Confirmed') };
  if (status === 'rejected') return { tone: 'error', label: ctx.t('Rejected') };
  if (status === 'failed') return { tone: 'error', label: ctx.t('Confirmation failed') };
  if (status === 'expired') return { tone: 'neutral', label: ctx.t('Confirmation expired') };
  return { tone: 'pending', label: ctx.t('Waiting on {{card}} {{id}}', { card, id: shortId(id) }) };
}

function createdSession(
  output: Record<string, unknown> | null,
  ctx: ToolCardContext
): ToolCardBlock | null {
  const id = str(output?.conversationId);
  if ((output?.status !== 'created' && output?.status !== 'queued') || !id) return null;
  // 状态已经在徽标里说过一次，这里只留可点的会话名
  return { kind: 'session', id, label: sessionLabel(id, ctx) };
}

register('session_send', (call, ctx) => {
  const args = rec(call.args);
  const output = rec(parseJson(call.output));
  const id = str(args?.conversationId);
  const steer = str(args?.mode) === 'steer';
  const title = ctx.t('Send message {{title}}', { title: sessionLabel(id, ctx) });
  const blocks: ToolCardBlock[] = [];
  const goal = str(args?.goal);
  if (goal)
    blocks.push({ kind: 'kv', rows: [{ label: ctx.t('Goal'), value: goal, display: 'long' }] });
  const message = str(args?.message);
  if (message) blocks.push({ kind: 'prompt', label: ctx.t('Message'), text: message });
  const error = errorText(call, ctx);
  if (error) blocks.unshift({ kind: 'error', text: error });
  let status: ToolCardStatus | undefined;
  if (error) status = { tone: 'error', label: ctx.t('Refused') };
  else if (output?.status === 'steered') {
    status = { tone: 'ok', label: ctx.t('Steered into the current turn') };
  } else if (output?.status === 'queued') {
    status = { tone: 'queued', label: ctx.t('Queued until the current turn ends') };
  } else if (output?.status === 'sent') {
    status = {
      tone: 'ok',
      label: steer ? ctx.t('Delivered as a new turn (the session was idle)') : ctx.t('Delivered'),
    };
  } else if (call.state === 'running') {
    status = { tone: 'neutral', label: steer ? ctx.t('Steering…') : ctx.t('Sending…') };
  }
  const session = id ? ({ kind: 'session', id, label: sessionLabel(id, ctx) } as const) : null;
  if (session) blocks.unshift(session);
  return view(call, title, blocks, status);
});

register('session_answer', (call, ctx) => {
  const args = rec(call.args);
  const output = rec(parseJson(call.output));
  const id = str(args?.conversationId);
  const answer = str(args?.answer);
  const error = errorText(call, ctx);
  return view(
    call,
    ctx.t('Answer {{title}}', { title: sessionLabel(id, ctx) }),
    [
      ...(id ? [{ kind: 'session' as const, id, label: sessionLabel(id, ctx) }] : []),
      ...(answer ? [{ kind: 'note' as const, text: answer }] : []),
      ...(error ? [{ kind: 'error' as const, text: error }] : []),
    ],
    error
      ? { tone: 'error', label: ctx.t('Refused') }
      : output?.status === 'answered'
        ? { tone: 'ok', label: ctx.t('Answered') }
        : call.state === 'running'
          ? { tone: 'neutral', label: ctx.t('Answering…') }
          : undefined
  );
});

register('task_settle', (call, ctx) => {
  const output = rec(parseJson(call.output));
  const listed = Array.isArray(output?.settled)
    ? output.settled
    : Array.isArray(rec(call.args)?.tasks)
      ? (rec(call.args)?.tasks as unknown[])
      : [];
  const entries = listed.flatMap((value) => {
    const item = rec(value);
    const action = item?.action;
    if (!item || (action !== 'stop' && action !== 'keep')) return [];
    return [{ item, action, done: output ? item.ok !== false : undefined }];
  });
  const stopped = entries.filter((entry) => entry.action === 'stop' && entry.done).length;
  const kept = entries.filter((entry) => entry.action === 'keep' && entry.done).length;
  const error = errorText(call, ctx);
  return view(
    call,
    ctx.t('Background task wrap-up'),
    [
      ...(entries.length > 0
        ? [
            {
              kind: 'list' as const,
              items: entries.map(({ item, action, done }) => ({
                title: str(item.command) ?? str(item.taskId) ?? '',
                badge:
                  done === false
                    ? ctx.t('Not running')
                    : action === 'stop'
                      ? ctx.t('Stopped')
                      : ctx.t('Kept'),
                badgeTone: (action === 'keep' && done !== false
                  ? 'pending'
                  : 'neutral') as ToolCardStatus['tone'],
                ...(str(item.reason) ? { detail: str(item.reason) } : {}),
              })),
            },
          ]
        : []),
      ...(error ? [{ kind: 'error' as const, text: error }] : []),
    ],
    error
      ? { tone: 'error', label: ctx.t('Failed') }
      : output
        ? { tone: 'neutral', label: ctx.t('Stop {{stopped}} · Keep {{kept}}', { stopped, kept }) }
        : call.state === 'running'
          ? { tone: 'neutral', label: ctx.t('Settling…') }
          : undefined
  );
});

register('session_task_stop', (call, ctx) => {
  const args = rec(call.args);
  const id = str(args?.conversationId);
  const taskId = str(args?.taskId);
  const output = rec(parseJson(call.output));
  const error = errorText(call, ctx);
  return view(
    call,
    ctx.t('Stop background task {{task}}', { task: taskId ?? '' }),
    [
      ...(id ? [{ kind: 'session' as const, id, label: sessionLabel(id, ctx) }] : []),
      ...(taskId ? [{ kind: 'note' as const, text: taskId }] : []),
      ...(error ? [{ kind: 'error' as const, text: error }] : []),
    ],
    error
      ? { tone: 'error', label: ctx.t('Refused') }
      : output?.status === 'stopped'
        ? { tone: 'ok', label: ctx.t('Stopped') }
        : call.state === 'running'
          ? { tone: 'neutral', label: ctx.t('Stopping…') }
          : undefined
  );
});

register('session_stop', (call, ctx) => {
  const id = str(rec(call.args)?.conversationId);
  const output = rec(parseJson(call.output));
  const error = errorText(call, ctx);
  const stillRunning = output?.status === 'running';
  const cancelled = output?.status === 'cancelled';
  const note = str(output?.note);
  return view(
    call,
    cancelled
      ? ctx.t('Cancel waiting dispatch')
      : ctx.t('Stop session {{title}}', { title: sessionLabel(id, ctx) }),
    [
      ...(id ? [{ kind: 'session' as const, id, label: sessionLabel(id, ctx) }] : []),
      ...(note ? [{ kind: 'note' as const, text: note }] : []),
      ...(error ? [{ kind: 'error' as const, text: error }] : []),
    ],
    error
      ? { tone: 'error', label: ctx.t('Refused') }
      : stillRunning
        ? { tone: 'queued', label: ctx.t('Still running') }
        : cancelled
          ? { tone: 'ok', label: ctx.t('Cancelled') }
          : { tone: 'ok', label: ctx.t('Stopped') }
  );
});

function dispatchCard(
  call: ToolCallInput,
  ctx: ToolCardContext,
  mode: 'create' | 'dispatch'
): ToolCardView {
  const args = rec(call.args);
  const output = rec(parseJson(call.output));
  const projectId = str(args?.projectId);
  const named =
    str(args?.title) ??
    (mode === 'dispatch' ? ctx.lookup?.todoText?.(str(args?.todoId) ?? '') : undefined) ??
    str(output?.conversationId);
  const titleText = named
    ? displayLabel(
        str(output?.conversationId),
        str(args?.title) ??
          (mode === 'dispatch' ? ctx.lookup?.todoText?.(str(args?.todoId) ?? '') : undefined)
      )
    : ctx.t('New session');
  const rows = [
    ...(projectId ? [{ label: ctx.t('Project'), value: projectLabel(projectId, ctx) }] : []),
    {
      label: ctx.t('Worktree'),
      value:
        args?.worktree === true ? ctx.t('Run in a worktree') : ctx.t('Run in the project checkout'),
    },
    ...(str(args?.checkout)
      ? [
          {
            label: ctx.t('Checkout'),
            value: str(args?.checkout) as string,
            display: 'path' as const,
          },
        ]
      : []),
    ...(str(args?.baseRef) ? [{ label: ctx.t('Base'), value: str(args?.baseRef) as string }] : []),
    ...(str(args?.branch)
      ? [{ label: ctx.t('New branch'), value: str(args?.branch) as string }]
      : []),
    ...(Array.isArray(args?.after) && args.after.length > 0
      ? [{ label: ctx.t('After'), value: (args.after as unknown[]).map(String).join(', ') }]
      : []),
    ...(str(args?.model) ? [{ label: ctx.t('Model'), value: str(args?.model) as string }] : []),
    ...(str(args?.goal)
      ? [{ label: ctx.t('Goal'), value: str(args?.goal) as string, display: 'long' as const }]
      : []),
  ];
  const prompt = str(args?.prompt);
  const error = errorText(call, ctx);
  const created = createdSession(output, ctx);
  const blocks: ToolCardBlock[] = [
    ...(error ? [{ kind: 'error' as const, text: error }] : []),
    ...(rows.length > 0 ? [{ kind: 'kv' as const, rows }] : []),
    ...(prompt
      ? [{ kind: 'prompt' as const, label: ctx.t('Dispatch instructions'), text: prompt }]
      : []),
    ...(created ? [created] : []),
  ];
  const key = mode === 'dispatch' ? 'Dispatch session {{title}}' : 'Create session {{title}}';
  return view(
    call,
    ctx.t(key, { title: titleText || ctx.t('New session') }),
    blocks,
    error
      ? { tone: 'error', label: ctx.t('Refused') }
      : output?.status === 'waiting'
        ? { tone: 'queued', label: ctx.t('Waiting for dependencies') }
        : output?.status === 'queued'
          ? {
              tone: 'queued',
              label:
                typeof output.position === 'number'
                  ? ctx.t('Queued at #{{n}}', { n: output.position })
                  : ctx.t('Queued'),
            }
          : (confirmation(output, ctx) ??
            (created ? { tone: 'ok', label: ctx.t('Created the session') } : undefined))
  );
}

register('session_create', (call, ctx) => dispatchCard(call, ctx, 'create'));
register('todo_item_dispatch', (call, ctx) => dispatchCard(call, ctx, 'dispatch'));

register('todo_item_add', (call, ctx) => {
  const args = rec(call.args);
  const output = rec(parseJson(call.output));
  const text = str(output?.text) ?? str(args?.text) ?? ctx.t('Not set');
  const rows = [
    ...(typeof output?.dueAt === 'number' || typeof args?.dueAt === 'number'
      ? [{ label: ctx.t('Due time'), value: formatStamp(Number(output?.dueAt ?? args?.dueAt)) }]
      : []),
    ...(str(args?.projectId)
      ? [{ label: ctx.t('Project'), value: projectLabel(str(args?.projectId), ctx) }]
      : []),
  ];
  return view(
    call,
    ctx.t('Add to-do {{text}}', { text }),
    rows.length ? [{ kind: 'kv', rows }] : []
  );
});

function todoTextOf(call: ToolCallInput, ctx: ToolCardContext): string {
  const args = rec(call.args);
  const output = rec(parseJson(call.output));
  const after = rec(output?.after);
  const before = rec(output?.before);
  const id = str(args?.todoId) ?? str(output?.todoId) ?? '';
  return (
    str(after?.text) ??
    str(before?.text) ??
    str(args?.text) ??
    (id ? ctx.lookup?.todoText?.(id) : undefined) ??
    (id ? shortId(id) : ctx.t('Not set'))
  );
}

register('todo_item_update', (call, ctx) => {
  const args = rec(call.args);
  const output = rec(parseJson(call.output));
  const before = rec(output?.before);
  const after = rec(output?.after);
  const blocks: ToolCardBlock[] = [];
  const error = errorText(call, ctx);
  if (error) blocks.push({ kind: 'error', text: error });
  if (before && after) {
    const wasDone = before.done === true;
    const nowDone = after.done === true;
    if (wasDone !== nowDone) {
      blocks.push({
        kind: 'note',
        text: nowDone ? ctx.t('Marked done') : ctx.t('Marked not done'),
      });
    }
    const diffs: { label: string; before: string; after: string }[] = [];
    if (
      str(before.text) !== str(after.text) &&
      (before.text !== undefined || after.text !== undefined)
    ) {
      if (String(before.text ?? '') !== String(after.text ?? '')) {
        diffs.push({
          label: ctx.t('To-do text'),
          before: String(before.text ?? ''),
          after: String(after.text ?? ''),
        });
      }
    }
    if ((before.dueAt ?? null) !== (after.dueAt ?? null)) {
      diffs.push({
        label: ctx.t('Due time'),
        before: typeof before.dueAt === 'number' ? formatStamp(before.dueAt) : ctx.t('Not set'),
        after: typeof after.dueAt === 'number' ? formatStamp(after.dueAt) : ctx.t('Not set'),
      });
    }
    if (String(before.projectId ?? '') !== String(after.projectId ?? '')) {
      diffs.push({
        label: ctx.t('Project'),
        before: projectLabel(str(before.projectId), ctx),
        after: projectLabel(str(after.projectId), ctx),
      });
    }
    if (diffs.length > 0) blocks.push({ kind: 'diff', rows: diffs });
  } else if (args?.done === true) blocks.push({ kind: 'note', text: ctx.t('Marked done') });
  else if (args?.done === false) blocks.push({ kind: 'note', text: ctx.t('Marked not done') });
  return view(
    call,
    ctx.t('Update to-do {{text}}', { text: todoTextOf(call, ctx) }),
    blocks,
    error ? { tone: 'error', label: ctx.t('Refused') } : undefined
  );
});

const TODO_STATUS_KEY: Record<string, string> = {
  todo: 'To do',
  active: 'In progress',
  problem: 'Problem',
  done: 'Done',
};

register('todo_list', (call, ctx) => {
  const output = rec(parseJson(call.output));
  const todos = Array.isArray(output?.todos) ? output.todos : [];
  const items = todos.flatMap((entry) => {
    const row = rec(entry);
    if (!row) return [];
    const status = str(row.status);
    const label = status ? ctx.t(TODO_STATUS_KEY[status] ?? status) : undefined;
    return [
      {
        title: plainUntrusted(row.text) ?? ctx.t('Not set'),
        ...(label ? { badge: label } : {}),
      },
    ];
  });
  const error = errorText(call, ctx);
  return view(
    call,
    ctx.t('List to-dos'),
    [
      ...(error ? [{ kind: 'error' as const, text: error }] : []),
      ...(items.length > 0 ? [{ kind: 'list' as const, items }] : []),
    ],
    error ? { tone: 'error', label: ctx.t('Refused') } : undefined
  );
});

function scheduleWhen(args: Record<string, unknown> | null, ctx: ToolCardContext): string {
  const cron = str(args?.cron);
  if (cron) return cronPhrase(cron, ctx.locale);
  const at = str(args?.at);
  if (!at) return ctx.t('Not set');
  const ms = Date.parse(at);
  return ctx.t('Once at {{time}}', { time: Number.isNaN(ms) ? at : formatStamp(ms) });
}

register('schedule_add', (call, ctx) => {
  const args = rec(call.args);
  const output = rec(parseJson(call.output));
  const name = str(args?.name) ?? str(output?.name) ?? ctx.t('Not set');
  const prompt = str(args?.prompt);
  const error = errorText(call, ctx);
  const blocks: ToolCardBlock[] = [
    ...(error ? [{ kind: 'error' as const, text: error }] : []),
    { kind: 'note', text: scheduleWhen(args, ctx) },
    ...(typeof output?.nextRunAt === 'number'
      ? [
          {
            kind: 'note' as const,
            text: ctx.t('Next run {{time}}', { time: formatStamp(output.nextRunAt) }),
          },
        ]
      : []),
    ...(prompt ? [{ kind: 'markdown' as const, text: prompt, collapsed: true }] : []),
  ];
  return view(
    call,
    ctx.t('Add schedule {{name}}', { name }),
    blocks,
    error ? { tone: 'error', label: ctx.t('Refused') } : undefined
  );
});

register('schedule_remove', (call, ctx) => {
  const args = rec(call.args);
  const output = rec(parseJson(call.output));
  const id = str(args?.scheduleId) ?? str(output?.scheduleId) ?? '';
  const name = str(output?.name) ?? str(args?.name) ?? (id ? shortId(id) : ctx.t('Not set'));
  const error = errorText(call, ctx);
  return view(
    call,
    ctx.t('Remove schedule {{name}}', { name }),
    error ? [{ kind: 'error', text: error }] : [],
    error ? { tone: 'error', label: ctx.t('Refused') } : undefined
  );
});

register('session_list', (call, ctx) => {
  const args = rec(call.args);
  const output = rec(parseJson(call.output));
  const projectId = str(args?.projectId);
  const project = projectId ? projectLabel(projectId, ctx) : '';
  const sessions = Array.isArray(output?.sessions) ? output.sessions : [];
  const items = sessions.flatMap((entry) => {
    const row = rec(entry);
    if (!row) return [];
    const pending = pendingCount(row.pending);
    const badge = stateBadge(row.state, ctx);
    return [
      {
        title: str(row.title) ?? sessionLabel(str(row.conversationId), ctx),
        badge: badge.badge,
        badgeTone: badge.badgeTone,
        ...(pending > 0 ? { detail: ctx.t('{{count}} pending', { count: pending }) } : {}),
        ...(str(row.conversationId) ? { sessionId: str(row.conversationId) } : {}),
      },
    ];
  });
  return view(
    call,
    project ? ctx.t('List sessions in {{project}}', { project }) : ctx.t('List sessions'),
    items.length > 0 ? [{ kind: 'list', items }] : []
  );
});

register('session_read', (call, ctx) => {
  const output = rec(parseJson(call.output));
  const id = str(output?.conversationId) ?? str(rec(call.args)?.conversationId);
  const title = str(output?.title) ?? sessionLabel(id, ctx);
  const error = errorText(call, ctx);
  // index 模式：单条消息全文，长文按 offset 分页
  if (typeof output?.index === 'number') {
    const full = plainUntrusted(output.text) ?? '';
    const blocks: ToolCardBlock[] = [];
    if (error) blocks.push({ kind: 'error', text: error });
    if (full) blocks.push({ kind: 'markdown', text: full, collapsed: longText(full) });
    const next = typeof output.nextOffset === 'number' ? output.nextOffset : undefined;
    if (next !== undefined)
      blocks.push({ kind: 'note', text: ctx.t('More text from character {{next}}', { next }) });
    return view(
      call,
      ctx.t('Read message {{index}} in {{title}}', { index: String(output.index), title }),
      blocks,
      error ? { tone: 'error', label: ctx.t('Refused') } : { tone: 'neutral', label: ctx.t('Read') }
    );
  }
  const badge = stateBadge(output?.state, ctx);
  const status: ToolCardStatus = { tone: badge.badgeTone, label: badge.badge };
  const pending = rec(output?.pending);
  const approvals = typeof pending?.approvals === 'number' ? pending.approvals : 0;
  const asks = typeof pending?.asks === 'number' ? pending.asks : 0;
  const messages = Array.isArray(output?.messages) ? output.messages : [];
  const truncated = messages.flatMap((entry) => {
    const row = rec(entry);
    return row?.truncated === true && typeof row.index === 'number' ? [row.index] : [];
  });
  const summary = messages
    .flatMap((entry) => {
      const row = rec(entry);
      const text = str(row?.text);
      if (!row || !text) return [];
      const role = row.role === 'assistant' ? ctx.t('Assistant') : ctx.t('User');
      return [`${role}: ${firstLine(text)}`];
    })
    .join('\n');
  const blocks: ToolCardBlock[] = [
    ...(error ? [{ kind: 'error' as const, text: error }] : []),
    ...(approvals > 0 || asks > 0
      ? [
          {
            kind: 'kv' as const,
            rows: [
              { label: ctx.t('Pending approvals'), value: String(approvals) },
              { label: ctx.t('Pending questions'), value: String(asks) },
            ],
          },
        ]
      : []),
  ];
  if (summary) blocks.push({ kind: 'markdown', text: summary, collapsed: true });
  if (truncated.length > 0)
    blocks.push({
      kind: 'note',
      text: ctx.t('Truncated messages {{indexes}}: read them by index', {
        indexes: truncated.map((index) => `#${index}`).join(', '),
      }),
    });
  // 会话状态只出现在徽标上，详情里不再重复一遍
  return view(
    call,
    ctx.t('Read session {{title}}', { title }),
    blocks,
    error ? { tone: 'error', label: ctx.t('Refused') } : status
  );
});

function projectBits(row: Record<string, unknown>, ctx: ToolCardContext): string {
  const git = rec(row.git);
  const parts: string[] = [];
  if (git) {
    parts.push(str(git.branch) ?? ctx.t('No local branch'));
    parts.push(git.dirty === true ? ctx.t('Uncommitted changes') : ctx.t('Clean tree'));
  } else parts.push(ctx.t('No local branch'));
  return parts.join(' · ');
}

register('project_list', (call, ctx) => {
  const projects = Array.isArray(rec(parseJson(call.output))?.projects)
    ? (rec(parseJson(call.output))?.projects as unknown[])
    : [];
  return view(call, ctx.t('List projects'), [
    {
      kind: 'list',
      items: projects.flatMap((entry) => {
        const row = rec(entry);
        if (!row) return [];
        const name = str(row.name) ?? projectLabel(str(row.projectId), ctx);
        return [{ title: name, detail: projectBits(row, ctx) }];
      }),
    },
  ]);
});

register('project_info', (call, ctx) => {
  const output = rec(parseJson(call.output)) ?? {};
  const name =
    str(output.name) ?? projectLabel(str(output.projectId) ?? str(rec(call.args)?.projectId), ctx);
  return view(call, ctx.t('Project {{name}}', { name }), [
    { kind: 'note', text: projectBits(output, ctx) },
  ]);
});

/** 相对时长：秘书看的是"跑了多久"，不是绝对时间 */
function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes > 0 ? `${minutes}m ${total % 60}s` : `${total}s`;
}

const TASK_STATE: Record<string, { key: string; tone: ToolCardStatus['tone'] }> = {
  running: { key: 'Running', tone: 'ok' },
  exited: { key: 'Exited', tone: 'neutral' },
  killed: { key: 'Killed', tone: 'error' },
};

register('repo_status', (call, ctx) => {
  const output = rec(parseJson(call.output)) ?? {};
  const project = projectLabel(str(output.projectId) ?? str(rec(call.args)?.projectId), ctx);
  const error = errorText(call, ctx);
  const branch = str(output.branch);
  const head = rec(output.head);
  const changes = rec(output.changes);
  const operation = rec(output.operation);
  const base = rec(output.base);
  const contains = rec(output.contains);
  const blocks: ToolCardBlock[] = [];
  if (error) blocks.push({ kind: 'error', text: error });
  const total = typeof changes?.total === 'number' ? changes.total : 0;
  const rows: { label: string; value: string }[] = [
    { label: ctx.t('Branch'), value: branch ?? ctx.t('No local branch') },
  ];
  if (head) {
    const subject = plainUntrusted(head.subject) ?? '';
    rows.push({ label: ctx.t('HEAD'), value: `${str(head.sha) ?? ''} ${subject}`.trim() });
  }
  rows.push({
    label: ctx.t('Working tree'),
    value: total === 0 ? ctx.t('Clean tree') : ctx.t('{{count}} changed files', { count: total }),
  });
  if (base)
    rows.push({
      label: ctx.t('Against {{ref}}', { ref: str(base.ref) ?? '' }),
      value: ctx.t('{{ahead}} ahead, {{behind}} behind', {
        ahead: typeof base.ahead === 'number' ? base.ahead : 0,
        behind: typeof base.behind === 'number' ? base.behind : 0,
      }),
    });
  if (contains)
    rows.push({
      label: ctx.t('Contains {{sha}}', { sha: str(contains.sha) ?? '' }),
      value: contains.inHead === true ? ctx.t('Yes') : ctx.t('No'),
    });
  const inProgress = [
    ...(operation?.merge === true ? [ctx.t('Merge')] : []),
    ...(operation?.rebase === true ? [ctx.t('Rebase')] : []),
  ];
  if (inProgress.length > 0)
    rows.push({ label: ctx.t('In progress'), value: inProgress.join(' · ') });
  blocks.push({ kind: 'kv', rows });

  const commits = Array.isArray(output.commits) ? output.commits : [];
  if (commits.length > 0)
    blocks.push({
      kind: 'list',
      items: commits.flatMap((entry) => {
        const row = rec(entry);
        const sha = str(row?.sha);
        if (!row || !sha) return [];
        const subject = plainUntrusted(row.subject) ?? '';
        const author = plainUntrusted(row.author) ?? '';
        const at = typeof row.at === 'number' ? formatStamp(row.at) : '';
        const detail = [author, at].filter(Boolean).join(' · ');
        return [{ title: `${sha} ${subject}`.trim(), ...(detail ? { detail } : {}) }];
      }),
    });

  const files = Array.isArray(changes?.files) ? changes.files : [];
  if (files.length > 0)
    blocks.push({
      kind: 'list',
      items: files.flatMap((entry) => {
        const row = rec(entry);
        const filePath = str(row?.path);
        if (!row || !filePath) return [];
        return [{ title: filePath, badge: str(row.status) ?? '' }];
      }),
    });

  const worktrees = Array.isArray(output.worktrees) ? output.worktrees : [];
  if (worktrees.length > 1)
    blocks.push({
      kind: 'list',
      items: worktrees.flatMap((entry) => {
        const row = rec(entry);
        const worktreePath = str(row?.path);
        if (!row || !worktreePath) return [];
        const detail = [str(row.branch) ?? ctx.t('No local branch'), str(row.head) ?? '']
          .filter(Boolean)
          .join(' · ');
        return [{ title: worktreePath, detail }];
      }),
    });

  return view(
    call,
    ctx.t('Repository status {{project}}', { project }),
    blocks,
    error
      ? { tone: 'error', label: ctx.t('Refused') }
      : { tone: 'neutral', label: branch ?? ctx.t('No local branch') }
  );
});

register('repo_diff', (call, ctx) => {
  const output = rec(parseJson(call.output)) ?? {};
  const project = projectLabel(str(output.projectId) ?? str(rec(call.args)?.projectId), ctx);
  const error = errorText(call, ctx);
  const base = str(output.base);
  const ref = str(output.ref);
  const totalFiles = typeof output.totalFiles === 'number' ? output.totalFiles : 0;
  const added = typeof output.added === 'number' ? output.added : 0;
  const deleted = typeof output.deleted === 'number' ? output.deleted : 0;
  const truncated = output.truncated === true;
  const blocks: ToolCardBlock[] = [];
  if (error) blocks.push({ kind: 'error', text: error });
  blocks.push({
    kind: 'kv',
    rows: [
      { label: ctx.t('Base'), value: base ?? '' },
      { label: ctx.t('Ref'), value: ref ?? '' },
      {
        label: ctx.t('Changed files'),
        value: ctx.t('{{count}} files (+{{added}} −{{deleted}})', {
          count: totalFiles,
          added,
          deleted,
        }),
      },
    ],
  });
  const files = Array.isArray(output.files) ? output.files : [];
  if (files.length > 0)
    blocks.push({
      kind: 'list',
      items: files.flatMap((entry) => {
        const row = rec(entry);
        const filePath = str(row?.path);
        if (!row || !filePath) return [];
        const badge = str(row.status) ?? '';
        const lines =
          typeof row.added === 'number' && typeof row.deleted === 'number'
            ? `+${row.added} −${row.deleted}`
            : row.binary === true
              ? ctx.t('Binary')
              : '';
        const from = str(row.fromPath);
        const detail = [lines, from ? ctx.t('from {{path}}', { path: from }) : '']
          .filter(Boolean)
          .join(' · ');
        return [{ title: filePath, badge, ...(detail ? { detail } : {}) }];
      }),
    });
  if (truncated)
    blocks.push({
      kind: 'kv',
      rows: [
        {
          label: ctx.t('Truncated'),
          value: ctx.t('{{count}} files total, only the first ones are listed', {
            count: totalFiles,
          }),
        },
      ],
    });
  return view(
    call,
    ctx.t('Repository diff {{project}}', { project }),
    blocks,
    error
      ? { tone: 'error', label: ctx.t('Refused') }
      : {
          tone: 'neutral',
          label: ctx.t('+{{added}} −{{deleted}}', { added, deleted }),
        }
  );
});

register('session_tasks', (call, ctx) => {
  const output = rec(parseJson(call.output));
  const id = str(output?.conversationId) ?? str(rec(call.args)?.conversationId);
  const title = sessionLabel(id, ctx);
  const error = errorText(call, ctx);
  const tasks = Array.isArray(output?.tasks) ? output.tasks : [];
  const running = tasks.filter((entry) => rec(entry)?.state === 'running').length;
  const blocks: ToolCardBlock[] = [];
  if (error) blocks.push({ kind: 'error', text: error });
  if (tasks.length > 0)
    blocks.push({
      kind: 'list',
      items: tasks.flatMap((entry) => {
        const row = rec(entry);
        if (!row) return [];
        const state = str(row.state) ?? '';
        const known = TASK_STATE[state];
        const ran =
          typeof row.ranMs === 'number'
            ? ctx.t('ran {{duration}}', { duration: durationText(row.ranMs) })
            : '';
        const exit =
          typeof row.exitCode === 'number' ? ctx.t('exit {{code}}', { code: row.exitCode }) : '';
        const alive =
          row.alive === false
            ? ctx.t('Process gone')
            : row.stalled === true
              ? ctx.t('Past its deadline')
              : '';
        const service = row.persistent === true ? ctx.t('Persistent service') : '';
        const leftover = str(row.leftover) ? ctx.t('Leftover') : '';
        const detail = [ran, exit, alive, service, leftover].filter(Boolean).join(' · ');
        return [
          {
            title:
              firstLine(plainUntrusted(row.command) ?? '') ||
              str(row.taskId) ||
              ctx.t('Unknown task'),
            badge: known ? ctx.t(known.key) : state,
            badgeTone: known?.tone ?? 'neutral',
            ...(detail ? { detail } : {}),
          },
        ];
      }),
    });
  return view(
    call,
    ctx.t('Background tasks in {{title}}', { title }),
    blocks,
    error
      ? { tone: 'error', label: ctx.t('Refused') }
      : running > 0
        ? { tone: 'ok', label: ctx.t('{{count}} running', { count: running }) }
        : { tone: 'neutral', label: ctx.t('{{count}} tasks', { count: tasks.length }) }
  );
});

register('session_activity', (call, ctx) => {
  const output = rec(parseJson(call.output));
  const id = str(output?.conversationId) ?? str(rec(call.args)?.conversationId);
  const title = sessionLabel(id, ctx);
  const error = errorText(call, ctx);
  const calls = Array.isArray(output?.calls) ? output.calls : [];
  const failed = calls.filter((entry) => {
    const row = rec(entry);
    return row?.ok === false && row.pending !== true;
  }).length;
  const blocks: ToolCardBlock[] = [];
  if (error) blocks.push({ kind: 'error', text: error });
  if (calls.length > 0)
    blocks.push({
      kind: 'list',
      items: calls.flatMap((entry) => {
        const row = rec(entry);
        const name = str(row?.name);
        if (!row || !name) return [];
        const pending = row.pending === true;
        const ok = row.ok === true;
        const parts = [
          typeof row.durationMs === 'number' ? durationText(row.durationMs) : '',
          typeof row.at === 'number' ? formatStamp(row.at) : '',
          firstLine(plainUntrusted(row.command) ?? ''),
        ].filter(Boolean);
        return [
          {
            title: friendlyName(name, ctx),
            badge: pending ? ctx.t('Running') : ok ? ctx.t('Succeeded') : ctx.t('Failed'),
            badgeTone: pending ? 'pending' : ok ? 'ok' : ('error' as ToolCardStatus['tone']),
            ...(parts.length > 0 ? { detail: parts.join(' · ') } : {}),
          },
        ];
      }),
    });
  return view(
    call,
    ctx.t('Recent tool calls in {{title}}', { title }),
    blocks,
    error
      ? { tone: 'error', label: ctx.t('Refused') }
      : failed > 0
        ? { tone: 'error', label: ctx.t('{{count}} failed', { count: failed }) }
        : { tone: 'ok', label: ctx.t('{{count}} calls', { count: calls.length }) }
  );
});

const PROFILE_FIELDS: Record<string, string> = {
  name: 'Name',
  avatarColor: 'Avatar color',
  model: 'Model',
  autonomy: 'Autonomy',
  autoApproveProjectIds: 'Auto-approved projects',
  visibleProjectIds: 'Visible projects',
  dispatchModel: 'Dispatch model',
  dispatchWorktree: 'Dispatch worktree',
  maxRunningDispatches: 'Dispatch limit',
  addressAs: 'What to call you',
  replyLanguage: 'Reply language',
  style: 'Communication style',
  notify: 'System notifications',
  dailyBriefAt: 'Daily brief time',
  persona: 'Persona',
};

register('secretary_profile_propose', (call, ctx) => {
  const output = rec(parseJson(call.output));
  const changes = Array.isArray(output?.changes) ? output.changes : [];
  const rows = changes.flatMap((entry) => {
    const row = rec(entry);
    const field = str(row?.field);
    if (!row || !field) return [];
    return [
      {
        label: ctx.t(PROFILE_FIELDS[field] ?? field),
        before: showValue(row.before, ctx),
        after: showValue(row.after, ctx),
      },
    ];
  });
  const error = errorText(call, ctx);
  return view(
    call,
    ctx.t('Propose profile changes'),
    [
      ...(error ? [{ kind: 'error' as const, text: error }] : []),
      ...(rows.length > 0 ? [{ kind: 'diff' as const, rows }] : []),
    ],
    error ? { tone: 'error', label: ctx.t('Refused') } : confirmation(output, ctx)
  );
});

function proposalBody(call: ToolCallInput, ctx: ToolCardContext, titleKey: string): ToolCardView {
  const args = rec(call.args);
  const output = rec(parseJson(call.output));
  const name = str(args?.name) ?? ctx.t('Not set');
  const description = str(args?.description);
  const body = str(args?.body) ?? str(args?.code);
  const error = errorText(call, ctx);
  return view(
    call,
    ctx.t(titleKey, { name }),
    [
      ...(error ? [{ kind: 'error' as const, text: error }] : []),
      ...(description ? [{ kind: 'note' as const, text: description }] : []),
      ...(body ? [{ kind: 'markdown' as const, text: body, collapsed: true }] : []),
    ],
    error ? { tone: 'error', label: ctx.t('Refused') } : confirmation(output, ctx)
  );
}

register('skill_propose', (call, ctx) => proposalBody(call, ctx, 'Propose skill {{name}}'));
register('tool_propose', (call, ctx) => proposalBody(call, ctx, 'Propose tool {{name}}'));

register('session_takeover_propose', (call, ctx) => {
  const args = rec(call.args);
  const id = str(args?.conversationId);
  const reason = str(args?.reason);
  const output = rec(parseJson(call.output));
  const error = errorText(call, ctx);
  return view(
    call,
    ctx.t('Ask to take over {{title}}', { title: sessionLabel(id, ctx) }),
    [
      ...(error ? [{ kind: 'error' as const, text: error }] : []),
      ...(reason ? [{ kind: 'note' as const, text: reason }] : []),
    ],
    error ? { tone: 'error', label: ctx.t('Refused') } : confirmation(output, ctx)
  );
});

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const CLEANUP_KIND_LABELS: Record<string, string> = {
  branch: 'Branch',
  worktree: 'Worktree',
  session: 'Session',
};

function fileName(target: string): string {
  const parts = target.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? target;
}

const BLOCKED_REASONS: Record<string, string> = {
  'not-merged': 'Not merged yet',
  'current-branch': 'Currently checked out',
  'used-by-worktree': 'Used by a worktree',
  'detached-head': 'Detached HEAD',
  'uncommitted-changes': 'Has uncommitted changes',
};

/** 清理项的一行：名字 + 类型徽标 + 合入/占用/大小 */
function cleanupRow(item: Record<string, unknown>, ctx: ToolCardContext) {
  const kind = str(item.kind) ?? '';
  const blocked = str(item.blocked);
  const mergedInto = Array.isArray(item.mergedInto)
    ? item.mergedInto.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const sizeBytes = typeof item.sizeBytes === 'number' ? item.sizeBytes : null;
  const details: string[] = [];
  if (mergedInto.length > 0)
    details.push(ctx.t('merged into {{refs}}', { refs: mergedInto.join(', ') }));
  if (sizeBytes !== null) details.push(formatBytes(sizeBytes));
  if (blocked) details.push(ctx.t(BLOCKED_REASONS[blocked] ?? blocked));
  return {
    title: str(item.name) ?? ctx.t('Not set'),
    badge: ctx.t(CLEANUP_KIND_LABELS[kind] ?? kind),
    badgeTone: blocked ? ('error' as const) : ('ok' as const),
    ...(details.length > 0 ? { detail: details.join(' · ') } : {}),
  };
}

register('image_view', (call, ctx) => {
  const args = rec(call.args);
  const error = errorText(call, ctx);
  const facts = error ? null : parseImageViewFacts(call.output);
  // 标题可以用参数里的路径；取图只认工具校验后回报的路径
  const target = facts?.path ?? str(args?.path) ?? '';
  const { width, height, size } = facts ?? { width: null, height: null, size: null };
  const name = target ? fileName(target) : ctx.t('Not set');
  const blocks: ToolCardBlock[] = [];
  if (error) blocks.push({ kind: 'error', text: error });
  else if (call.image || facts?.path)
    blocks.push({
      kind: 'image',
      ...(call.image ? { image: call.image } : {}),
      ...(facts?.path ? { path: facts.path } : {}),
      alt: name,
    });
  const rows: { label: string; value: string }[] = [];
  if (facts?.path) rows.push({ label: ctx.t('Path'), value: facts.path });
  if (width && height) rows.push({ label: ctx.t('Dimensions'), value: `${width} × ${height}` });
  if (size !== null) rows.push({ label: ctx.t('File size'), value: formatBytes(size) });
  if (rows.length > 0) blocks.push({ kind: 'kv', rows });
  return view(
    call,
    ctx.t('Look at {{name}}', { name }),
    blocks,
    error ? { tone: 'error', label: ctx.t('Refused') } : undefined
  );
});

register('cleanup_list', (call, ctx) => {
  const output = rec(parseJsonLine(call.output));
  const items = Array.isArray(output?.items)
    ? output.items.map(rec).filter((item): item is Record<string, unknown> => item !== null)
    : [];
  // 精简模式只给每类前几条，标题上的数量用总数，别让人以为只有这么点
  const total = typeof output?.total === 'number' ? output.total : items.length;
  const error = errorText(call, ctx);
  return view(
    call,
    ctx.t('Cleanup candidates · {{count}}', { count: total }),
    [
      ...(error ? [{ kind: 'error' as const, text: error }] : []),
      ...(items.length > 0
        ? [{ kind: 'list' as const, items: items.map((item) => cleanupRow(item, ctx)) }]
        : []),
    ],
    error ? { tone: 'error', label: ctx.t('Refused') } : undefined
  );
});

register('cleanup_apply', (call, ctx) => {
  const args = rec(call.args);
  const output = rec(parseJsonLine(call.output));
  const ids = Array.isArray(args?.ids) ? args.ids.length : 0;
  // all: true 时没有 ids，数量以 Main 回的总数为准
  const count = typeof output?.total === 'number' ? output.total : ids;
  const error = errorText(call, ctx);
  return view(
    call,
    ctx.t('Clean up {{count}} items', { count }),
    error ? [{ kind: 'error', text: error }] : [],
    error ? { tone: 'error', label: ctx.t('Refused') } : confirmation(output, ctx)
  );
});

register('memory_search', (call, ctx) => {
  const query = str(rec(call.args)?.query) ?? '';
  const hits = parseMemorySearchHits(call.output) ?? [];
  return view(call, ctx.t('Search memory {{query}} · {{count}}', { query, count: hits.length }), [
    { kind: 'list', items: hits.map((hit) => ({ title: hit.title || shortId(hit.id) })) },
  ]);
});

register('memory_capture', (call, ctx) => {
  const parsed = parseMemoryCapture(call.output, str(rec(call.args)?.content));
  if (!parsed) return genericRenderer(call, ctx);
  if (!parsed.written) {
    return view(call, ctx.t('Memory not written'), [
      {
        kind: 'list',
        items: parsed.candidates.map((hit) => ({
          title: hit.title,
          detail: firstLine(hit.content),
        })),
      },
    ]);
  }
  return view(call, ctx.t('Save memory {{title}}', { title: parsed.memory.title }), [
    { kind: 'note', text: firstLine(parsed.memory.content) },
  ]);
});

register('memory_delete', (call, ctx) => {
  const output = rec(parseJson(call.output));
  const id = str(output?.id) ?? str(rec(call.args)?.id) ?? '';
  const title = str(output?.title) ?? (id ? shortId(id) : ctx.t('Not set'));
  const content = str(output?.content);
  const error = errorText(call, ctx);
  return view(
    call,
    ctx.t('Delete memory {{title}}', { title }),
    [
      ...(error ? [{ kind: 'error' as const, text: error }] : []),
      ...(content ? [{ kind: 'note' as const, text: firstLine(content) }] : []),
    ],
    error ? { tone: 'error', label: ctx.t('Refused') } : undefined
  );
});

function searchSources(output: string | null): { title: string; url: string }[] {
  if (!output) return [];
  const sources: { title: string; url: string }[] = [];
  const pattern = /^\d+\.\s+\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gmu;
  for (const match of output.matchAll(pattern)) {
    sources.push({ title: match[1], url: match[2] });
  }
  return sources;
}

register('web_search', (call, ctx) => {
  const query = str(rec(call.args)?.query) ?? '';
  const sources = searchSources(call.output);
  return view(call, ctx.t('Web search {{query}}', { query }), [
    { kind: 'list', items: sources.map((source) => ({ title: source.title, detail: source.url })) },
  ]);
});

register('web_fetch', (call, ctx) => {
  const output = call.output ?? '';
  const fromArgs = str(rec(call.args)?.url);
  const fromOutput = /^Fetched (\S+)/u.exec(output)?.[1];
  const url = fromArgs ?? fromOutput ?? '';
  let domain = url;
  try {
    domain = new URL(url).host;
  } catch {
    domain = url || ctx.t('Not set');
  }
  const title = /^Title: (.+)$/mu.exec(output)?.[1]?.trim();
  return view(
    call,
    ctx.t('Fetch {{domain}}', { domain }),
    title ? [{ kind: 'note', text: title }] : []
  );
});

function genericRenderer(call: ToolCallInput, ctx: ToolCardContext): ToolCardView {
  const args = rec(call.args);
  const output = parseJson(call.output);
  const blocks: ToolCardBlock[] = [];
  const error = errorText(call, ctx);
  if (error) blocks.push({ kind: 'error', text: error });
  if (args && Object.keys(args).length > 0) {
    blocks.push({ kind: 'kv', rows: kvRows(args, ctx) });
  }
  if (isRecord(output)) blocks.push({ kind: 'kv', rows: kvRows(output, ctx) });
  else if (typeof call.output === 'string' && call.output.trim() && !error) {
    blocks.push({ kind: 'note', text: call.output.trim(), collapsed: longText(call.output) });
  }
  return view(
    call,
    friendlyName(call.name, ctx),
    blocks,
    error ? { tone: 'error', label: ctx.t('Refused') } : undefined
  );
}

export function aggregateState(states: readonly ToolCardState[]): ToolCardState {
  if (states.some((state) => state === 'error')) return 'error';
  if (states.some((state) => state === 'running' || state === 'reviewing')) return 'running';
  return 'ok';
}
