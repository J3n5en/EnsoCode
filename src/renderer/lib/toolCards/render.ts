import { SECRETARY_OPS } from '@shared/secretary/tools';
import { parseMemoryCapture, parseMemorySearchHits } from '@/components/chat/memorySearchHits';
import { parseMcpToolName } from '@/lib/mcpToolName';
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
    if (block.kind === 'markdown' || block.kind === 'note' || block.kind === 'error')
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
};

function errorText(call: ToolCallInput, ctx: ToolCardContext): string | null {
  if (call.state !== 'error') return null;
  const text = call.output?.trim() ?? '';
  if (!text) return ctx.t('Tool failed');
  const key = REASONS[text];
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
  if (output?.status !== 'created' || !id) return null;
  // 状态已经在徽标里说过一次，这里只留可点的会话名
  return { kind: 'session', id, label: sessionLabel(id, ctx) };
}

register('session_send', (call, ctx) => {
  const args = rec(call.args);
  const output = rec(parseJson(call.output));
  const id = str(args?.conversationId);
  const title = ctx.t('Send message {{title}}', { title: sessionLabel(id, ctx) });
  const blocks: ToolCardBlock[] = [];
  const message = str(args?.message);
  if (message) blocks.push({ kind: 'markdown', text: message, collapsed: longText(message) });
  const error = errorText(call, ctx);
  if (error) blocks.unshift({ kind: 'error', text: error });
  let status: ToolCardStatus | undefined;
  if (error) status = { tone: 'error', label: ctx.t('Refused') };
  else if (output?.status === 'queued') {
    status = { tone: 'queued', label: ctx.t('Queued until the current turn ends') };
  } else if (output?.status === 'sent') status = { tone: 'ok', label: ctx.t('Delivered') };
  else if (call.state === 'running') status = { tone: 'neutral', label: ctx.t('Sending…') };
  const session = id ? ({ kind: 'session', id, label: sessionLabel(id, ctx) } as const) : null;
  if (session) blocks.unshift(session);
  return view(call, title, blocks, status);
});

register('session_stop', (call, ctx) => {
  const id = str(rec(call.args)?.conversationId);
  const error = errorText(call, ctx);
  return view(
    call,
    ctx.t('Stop session {{title}}', { title: sessionLabel(id, ctx) }),
    [
      ...(id ? [{ kind: 'session' as const, id, label: sessionLabel(id, ctx) }] : []),
      ...(error ? [{ kind: 'error' as const, text: error }] : []),
    ],
    error ? { tone: 'error', label: ctx.t('Refused') } : { tone: 'ok', label: ctx.t('Stopped') }
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
    ...(str(args?.goal) ? [{ label: ctx.t('Goal'), value: str(args?.goal) as string }] : []),
  ];
  const prompt = str(args?.prompt);
  const error = errorText(call, ctx);
  const created = createdSession(output, ctx);
  const blocks: ToolCardBlock[] = [
    ...(error ? [{ kind: 'error' as const, text: error }] : []),
    ...(rows.length > 0 ? [{ kind: 'kv' as const, rows }] : []),
    // 提示词在详情里再折一层，默认只留一行
    ...(prompt ? [{ kind: 'markdown' as const, text: prompt, collapsed: true }] : []),
    ...(created ? [created] : []),
  ];
  const key = mode === 'dispatch' ? 'Dispatch session {{title}}' : 'Create session {{title}}';
  return view(
    call,
    ctx.t(key, { title: titleText || ctx.t('New session') }),
    blocks,
    error
      ? { tone: 'error', label: ctx.t('Refused') }
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
  const badge = stateBadge(output?.state, ctx);
  const status: ToolCardStatus = { tone: badge.badgeTone, label: badge.badge };
  const pending = rec(output?.pending);
  const approvals = typeof pending?.approvals === 'number' ? pending.approvals : 0;
  const asks = typeof pending?.asks === 'number' ? pending.asks : 0;
  const messages = Array.isArray(output?.messages) ? output.messages : [];
  const summary = messages
    .flatMap((entry) => {
      const row = rec(entry);
      const text = str(row?.text);
      if (!row || !text) return [];
      const role = row.role === 'assistant' ? ctx.t('Assistant') : ctx.t('User');
      return [`${role}: ${firstLine(text)}`];
    })
    .join('\n');
  const error = errorText(call, ctx);
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
