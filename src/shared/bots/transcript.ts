import type { BotId, BotProfile, DelegationState, GroupEntry, GroupTaskStatus } from '../types/bot';

export type TranscriptMember = Pick<BotProfile, 'id' | 'name' | 'title' | 'scope'>;

/** 面向模型的固定文案，集中放便于本地化 */
export const TRANSCRIPT_LABELS = {
  human: '用户',
  humanRole: '人类',
  system: '系统',
  deleted: '已删除成员',
  omitted: (count: number) => `（省略了 ${count} 条更早的消息）`,
  delegation: (from: string, to: string, state: string) =>
    `「${from}」委派给「${to}」的任务${state}`,
  delegationState: {
    queued: '排队中',
    running: '进行中',
    completed: '已完成',
    failed: '失败',
    canceled: '已取消',
  } satisfies Record<DelegationState, string>,
  intro: (title: string, self: string) => `你在群聊「${title}」中，你是 ${self}。群成员：`,
} as const;

export const GROUP_STATE_LABELS = {
  head: (title: string) =>
    `你的上下文刚被压缩，以下是群聊「${title}」当前状态（系统根据群记录生成，以此为准）：`,
  members: '成员与分工：',
  self: '你',
  boss: '群主',
  replying: '正在回复',
  waiting: '待回应（按顺序）：',
  delegations: '进行中的委派：',
  tasks: '看板未完成任务：',
  unassigned: '无人负责',
  taskStatus: {
    todo: '待办',
    doing: '进行中',
    done: '已完成',
    canceled: '已取消',
  } satisfies Record<GroupTaskStatus, string>,
  more: (count: number) => `…另有 ${count} 项`,
  footer: (seq: number) =>
    `群时间线当前到 seq ${seq}。已达成的约定见群记忆；需要更早的原话时用 group_history 按 seq / 关键词 / 发言人查。`,
} as const;

const DEFAULT_LIMIT = 40;
const STATE_MAX_CHARS = 4000;
const STATE_ITEM_CHARS = 160;
const STATE_MAX_ITEMS = 10;

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const oneLine = (value: string, max = STATE_ITEM_CHARS): string => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * 压缩后补给成员的群状态块：只用 Main 的权威数据确定性生成（成员分工、群主、待回应、进行中委派、
 * 看板未完成任务、时间线 seq），条目与总长都有上限。约定与决策由群记忆承载，不在这里生成。
 */
export function buildGroupStateBlock(input: {
  chatTitle: string;
  selfId: BotId;
  members: readonly TranscriptMember[];
  bossBotId: BotId | null;
  routing: { current: BotId | null; queue: readonly BotId[] };
  delegations: readonly { from: BotId; to: BotId; state: DelegationState; task: string }[];
  tasks: readonly { seq: number; title: string; status: GroupTaskStatus; assigneeBotId?: BotId }[];
  lastSeq: number;
  maxChars?: number;
}): string {
  const L = GROUP_STATE_LABELS;
  const nameOf = (id: BotId) =>
    input.members.find((m) => m.id === id)?.name ?? TRANSCRIPT_LABELS.deleted;
  const capped = (items: string[]) =>
    items.length > STATE_MAX_ITEMS
      ? [...items.slice(0, STATE_MAX_ITEMS), L.more(items.length - STATE_MAX_ITEMS)]
      : items;
  const lines = [
    L.head(oneLine(input.chatTitle, 60)),
    L.members,
    ...capped(
      input.members.map((m) => {
        const title = m.title ? `（${oneLine(m.title, 40)}）` : '';
        const scope = m.scope?.trim() ? `：${oneLine(m.scope)}` : '';
        const tags = [
          ...(m.id === input.bossBotId ? [L.boss] : []),
          ...(m.id === input.selfId ? [L.self] : []),
        ];
        return `- ${m.name}${title}${scope}${tags.length ? ` [${tags.join('，')}]` : ''}`;
      })
    ),
  ];
  const waiting = [
    ...(input.routing.current ? [`${nameOf(input.routing.current)}（${L.replying}）`] : []),
    ...input.routing.queue.map(nameOf),
  ];
  if (waiting.length) lines.push(`${L.waiting}${waiting.join('、')}`);
  if (input.delegations.length)
    lines.push(
      L.delegations,
      ...capped(
        input.delegations.map(
          (d) =>
            `- ${nameOf(d.from)} → ${nameOf(d.to)}（${TRANSCRIPT_LABELS.delegationState[d.state] ?? d.state}）：${oneLine(d.task)}`
        )
      )
    );
  if (input.tasks.length)
    lines.push(
      L.tasks,
      ...capped(
        input.tasks.map(
          (t) =>
            `- #${t.seq} ${oneLine(t.title)}（${L.taskStatus[t.status] ?? t.status}，${t.assigneeBotId ? nameOf(t.assigneeBotId) : L.unassigned}）`
        )
      )
    );
  lines.push(L.footer(input.lastSeq));
  const open = '<group-state>\n';
  const close = '\n</group-state>';
  const budget = Math.max(200, input.maxChars ?? STATE_MAX_CHARS) - open.length - close.length;
  let body = escapeXml(lines.join('\n'));
  if (body.length > budget) {
    // 页脚（seq 与 group_history 提示）必须保留，从中间截断
    const footer = `\n…\n${escapeXml(L.footer(input.lastSeq))}`;
    body = `${body.slice(0, Math.max(0, budget - footer.length)).replace(/&[a-z]*$/, '')}${footer}`;
  }
  return `${open}${body}${close}`;
}

function message(attrs: { from: string; role?: string; seq: number }, body: string): string {
  const role = attrs.role ? ` role="${escapeXml(attrs.role)}"` : '';
  return `<group-message from="${escapeXml(attrs.from)}"${role} seq="${attrs.seq}">${escapeXml(body)}</group-message>`;
}

function render(entry: GroupEntry, find: (id: BotId) => TranscriptMember | undefined): string {
  const nameOf = (id: BotId) => find(id)?.name ?? TRANSCRIPT_LABELS.deleted;
  switch (entry.kind) {
    case 'human':
      return message(
        { from: TRANSCRIPT_LABELS.human, role: TRANSCRIPT_LABELS.humanRole, seq: entry.seq },
        entry.text
      );
    case 'bot': {
      const member = find(entry.botId);
      return message(
        { from: member?.name ?? TRANSCRIPT_LABELS.deleted, role: member?.title, seq: entry.seq },
        entry.text
      );
    }
    case 'delegation': {
      const head = TRANSCRIPT_LABELS.delegation(
        nameOf(entry.from),
        nameOf(entry.to),
        TRANSCRIPT_LABELS.delegationState[entry.state] ?? entry.state
      );
      const summary = entry.summary?.replace(/\s+/g, ' ').trim();
      return message(
        { from: TRANSCRIPT_LABELS.system, seq: entry.seq },
        summary ? `${head}：${summary}` : head
      );
    }
    default:
      return message({ from: TRANSCRIPT_LABELS.system, seq: entry.seq }, entry.text);
  }
}

function intro(
  chatTitle: string,
  self: TranscriptMember | undefined,
  members: TranscriptMember[]
): string {
  const roster = members.map((m) => {
    const title = m.title ? `（${m.title}）` : '';
    return `- ${m.name}${title}${m.scope ? `：${m.scope}` : ''}`;
  });
  const body = [
    TRANSCRIPT_LABELS.intro(chatTitle, self?.name ?? TRANSCRIPT_LABELS.deleted),
    ...roster,
  ].join('\n');
  return `<group-info>\n${escapeXml(body)}\n</group-info>`;
}

/**
 * 成员轮到发言时的群聊增量：cursor 之后、非本人的条目，超出 limit 只留最后 limit 条。
 * 返回的 cursor 推进到这批的最大 seq（包括本人的条目）；首次（cursor=0）附群简介。
 */
export function buildGroupDelta(input: {
  entries: readonly GroupEntry[];
  botId: BotId;
  cursor: number;
  members: readonly TranscriptMember[];
  chatTitle: string;
  limit?: number;
  /** 读取下限（群「新对话」分隔线 seq）：之前的条目不进上下文 */
  floor?: number;
}): { text: string; cursor: number } {
  const { botId, chatTitle } = input;
  const cursor = Number.isSafeInteger(input.cursor) && input.cursor > 0 ? input.cursor : 0;
  const after = Math.max(
    cursor,
    Number.isSafeInteger(input.floor) && (input.floor as number) > 0 ? (input.floor as number) : 0
  );
  const limit =
    Number.isSafeInteger(input.limit) && (input.limit as number) > 0
      ? (input.limit as number)
      : DEFAULT_LIMIT;
  const members = (Array.isArray(input.members) ? input.members : []).filter(
    (m): m is TranscriptMember =>
      Boolean(m) && typeof m.id === 'string' && typeof m.name === 'string'
  );
  const find = (id: BotId) => members.find((m) => m.id === id);
  const fresh = (Array.isArray(input.entries) ? input.entries : [])
    .filter((e) => e && typeof e === 'object' && Number.isSafeInteger(e.seq) && e.seq > after)
    .sort((a, b) => a.seq - b.seq);
  const nextCursor = fresh.at(-1)?.seq ?? after;
  const visible = fresh.filter((e) => !(e.kind === 'bot' && e.botId === botId));
  if (visible.length === 0) return { text: '', cursor: nextCursor };
  const omitted = Math.max(0, visible.length - limit);
  const lines = [
    ...(cursor === 0
      ? [intro(typeof chatTitle === 'string' ? chatTitle : '', find(botId), members)]
      : []),
    ...(omitted > 0 ? [TRANSCRIPT_LABELS.omitted(omitted)] : []),
    ...visible.slice(omitted).map((e) => render(e, find)),
  ];
  return { text: lines.join('\n'), cursor: nextCursor };
}
