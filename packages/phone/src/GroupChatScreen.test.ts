import type { PairBotChatSummary, PairGroupEntry } from '@enso/pair';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { GroupChatScreen } from './GroupChatScreen';

vi.mock('@/components/chat/ApprovalBar', () => ({ ApprovalBar: () => null }));
vi.mock('@/components/chat/AskBar', () => ({ AskBar: () => null }));
vi.mock('@/components/chat/Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));

const chat: PairBotChatSummary = {
  id: 'chat',
  kind: 'group',
  title: 'Team',
  members: [],
  bossBotId: null,
  updatedAt: 0,
  lastSeq: 4,
  sessions: {},
  status: 'idle',
  epochSeq: 2,
};
const entries: PairGroupEntry[] = [
  { id: 'old', seq: 1, at: 1, kind: 'human', text: 'OLD_SECRET', mentions: [] },
  { id: 'epoch', seq: 2, at: 2, kind: 'system', text: '新对话', newConversation: true },
  { id: 'new', seq: 3, at: 3, kind: 'human', text: 'CURRENT_TASK', mentions: [] },
  {
    id: 'failure',
    seq: 4,
    at: 4,
    kind: 'system',
    text: '回复失败：503',
    failure: { botId: 'bot', mode: 'resume', conversationId: 'conv' },
  },
];
const noop = () => {};
const render = (patch: Partial<Parameters<typeof GroupChatScreen>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(GroupChatScreen, {
      chat,
      bots: new Map(),
      timeline: { entries, lastSeq: 4, hasOlder: false },
      state: undefined,
      pending: [],
      activities: [],
      clockOffset: 0,
      connState: 'online',
      stateLabel: 'online',
      notice: null,
      onOpenDrawer: noop,
      onLoadOlder: noop,
      onSend: noop,
      onStop: noop,
      onOpenProcess: noop,
      onApproval: noop,
      onAsk: noop,
      onRetry: noop,
      ...patch,
    })
  );

describe('phone group recovery and folding UI', () => {
  it('shows new session and disables it for unsupported, offline, read-only or busy states', () => {
    const button = (patch: Partial<Parameters<typeof GroupChatScreen>[0]>) =>
      render({ onNewSession: noop, canCreate: true, ...patch }).match(
        /<button[^>]*aria-label="新建会话"[^>]*>/
      )?.[0];
    expect(button({})).toBeDefined();
    expect(button({})).not.toContain('disabled=""');
    for (const patch of [
      { canCreate: false },
      { deviceReadOnly: true },
      { connState: 'offline' as const },
    ]) {
      expect(button(patch)).toContain('disabled=""');
    }
  });
  it('folds old messages by default while keeping the current task and recovery button', () => {
    const html = render();
    expect(html).not.toContain('OLD_SECRET');
    expect(html).toContain('CURRENT_TASK');
    expect(html).toContain('更早的对话');
    expect(html).toContain('>重试</button>');
  });
  it('does not offer write actions to read-only devices or retry obsolete failures', () => {
    expect(render({ deviceReadOnly: true })).not.toContain('>重试</button>');
    expect(
      render({
        timeline: {
          entries: [
            ...entries,
            { id: 'next', seq: 5, at: 5, kind: 'human', text: 'new', mentions: [] },
          ],
          lastSeq: 5,
          hasOlder: false,
        },
      })
    ).not.toContain('>重试</button>');
  });
  it('offers a path back to latest when the history window has been trimmed', () => {
    expect(
      render({ timeline: { entries, lastSeq: 900, hasOlder: true, history: true } })
    ).toContain('回到最新消息');
  });
  it('renders progress as one line under the member name; old phones skip unknown kinds without crashing', () => {
    const progress = {
      id: 'p',
      seq: 5,
      at: 5,
      kind: 'progress',
      botId: 'bot',
      taskId: 't',
      taskSeq: 3,
      delegationId: 'd',
      phase: 'started',
      text: '开工 #3『登录页』',
    } as PairGroupEntry;
    const html = render({
      bots: new Map([
        ['bot', { id: 'bot', name: 'Bob', title: '', avatarColor: '#000000', status: 'idle' }],
      ]),
      timeline: { entries: [...entries, progress], lastSeq: 5, hasOlder: false },
    });
    expect(html).toContain('Bob');
    expect(html.replace(/<[^>]+>/g, '')).toContain('开工 #3『登录页』');
    const future = { ...progress, kind: 'from-the-future' } as unknown as PairGroupEntry;
    const old = render({
      timeline: { entries: [...entries, future], lastSeq: 5, hasOlder: false },
    });
    expect(old).toContain('CURRENT_TASK');
    expect(old).not.toContain('开工 #3');
  });

  it('styles progress by phase and marks #N; task-bound delegation results start collapsed', () => {
    const delegation = (seq: number, taskId?: string) =>
      ({
        id: `d${seq}`,
        seq,
        at: seq,
        kind: 'delegation',
        delegationId: `d${seq}`,
        from: 'boss',
        to: 'bot',
        state: 'completed',
        summary: `RESULT_${seq}`,
        ...(taskId ? { taskId } : {}),
      }) as PairGroupEntry;
    const progress = {
      id: 'p',
      seq: 7,
      at: 7,
      kind: 'progress',
      botId: 'bot',
      taskId: 't',
      taskSeq: 3,
      delegationId: 'd5',
      phase: 'delivered',
      text: '交付 #3：登录页做完了',
    } as PairGroupEntry;
    const html = render({
      timeline: {
        entries: [...entries, delegation(5, 't'), delegation(6), progress],
        lastSeq: 7,
        hasOlder: false,
      },
    });
    expect(html).toContain('data-phase="delivered"');
    expect(html).toMatch(/<span[^>]*>#3<\/span>/);
    expect(html).not.toContain('RESULT_5');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('RESULT_6');
  });

  it('shows the topic switcher only when the desktop supports threads', () => {
    expect(render({ onNewSession: noop, canCreate: true })).not.toContain('aria-label="切换话题"');
    const threads = {
      entries: [
        { id: 'chat', title: '主话题', activityAt: 1, unread: false, running: false },
        { id: 't1', title: '发布清单', activityAt: 2, unread: false, running: true },
      ],
      currentId: 't1',
      rootId: 'chat',
      onSelect: noop,
      onCreate: noop,
    };
    const html = render({ onNewSession: noop, canCreate: true, threads });
    const trigger = html.match(/<button[^>]*aria-label="切换话题"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(trigger).toContain('发布清单');
    expect(trigger).not.toContain('disabled=""');
    const create = (patch: Partial<typeof threads> & { disabledHint?: string }) =>
      render({ threads: { ...threads, ...patch } }).match(
        /<button[^>]*aria-label="新话题"[^>]*>/
      )?.[0];
    expect(html).not.toContain('aria-label="新建会话"');
    expect(create({})).not.toContain('disabled=""');
    const blocked = create({ disabledHint: '只读设备不能切换或新建话题' });
    expect(blocked).toContain('disabled=""');
    expect(blocked).toContain('title="只读设备不能切换或新建话题"');
    // 只读也能看列表
    expect(
      render({ threads: { ...threads, disabledHint: 'x' } }).match(
        /<button[^>]*aria-label="切换话题"[^>]*>/
      )?.[0]
    ).not.toContain('disabled=""');
  });
});
