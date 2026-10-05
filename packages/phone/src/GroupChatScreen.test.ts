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
});
