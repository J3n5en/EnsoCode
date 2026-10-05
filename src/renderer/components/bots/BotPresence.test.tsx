import { translate } from '@shared/i18n';
import type { BotProfile, Delegation } from '@shared/types/bot';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Presence, PresenceSession } from '@/stores/bots/presence';
import { MemberBusyBar, PresenceAvatar } from './BotPresence';
import { DelegationCard } from './DelegationCard';
import { PresenceChip, presenceLabel } from './PresenceMark';

const store = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  locale: 'zh' as 'zh' | 'en',
}));
vi.mock('@/stores/bots', () => ({
  useBotsStore: (select: (state: unknown) => unknown) => select(store.state),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      translate(store.locale, key, params),
  }),
}));

vi.mock('@/components/ui/preview-card', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/preview-card')>()),
  PreviewCardPopup: ({ children }: { children: ReactNode }) =>
    createElement('div', { 'data-testid': 'hover-details' }, children),
}));

const bot = (id: string, name: string) => ({ id, name, avatar: { color: '#888' } }) as BotProfile;
const bots = new Map([
  ['b1', bot('b1', 'Jason')],
  ['b2', bot('b2', 'Anran')],
]);
const chat = { id: 'chat1', sessions: { b2: { conversationId: 'c2' } } };
const delegation = {
  id: 'd1',
  chatId: 'chat1',
  parentBotId: 'boss',
  targetBotId: 'b1',
  task: '浏览器标签页锁\n细节',
  childConversationId: 'k1',
  state: 'running',
  createdAt: 1,
} as Delegation;

const session = (patch: Partial<PresenceSession> = {}): PresenceSession => ({
  status: 'running',
  messages: [],
  pendingApprovals: [],
  pendingAsks: [],
  toolOutputs: {},
  ...patch,
});

const cases: { state: Presence; zh: string; en: string; patch: Record<string, unknown> }[] = [
  { state: 'idle', zh: '空闲', en: 'Free', patch: {} },
  { state: 'think', zh: '思考', en: 'Planning', patch: { delegations: [delegation] } },
  {
    state: 'work',
    zh: '执行',
    en: 'Busy',
    patch: {
      sessions: {
        c2: session({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] }),
      },
    },
  },
  {
    state: 'wait',
    zh: '等待',
    en: 'Needs you',
    patch: { sessions: { c2: session({ pendingAsks: [{ requestId: 'q', question: 'Which?' }] }) } },
  },
  {
    state: 'stuck',
    zh: '异常',
    en: 'Stuck',
    patch: { silences: [{ conversationId: 'c2', since: 5 }] },
  },
  {
    state: 'done',
    zh: '完成',
    en: 'Finished',
    patch: {
      delegations: [{ ...delegation, targetBotId: 'b2', state: 'completed', finishedAt: 200 }],
    },
  },
];

const render = () =>
  renderToStaticMarkup(
    createElement(MemberBusyBar, {
      chatId: 'chat1',
      memberIds: ['b1', 'b2'],
      bots,
      onOpenLive: () => {},
    })
  );

describe('MemberBusyBar', () => {
  beforeEach(() => {
    store.locale = 'zh';
    store.state = {
      chats: [chat],
      sessions: {},
      queue: [],
      silences: [],
      delegations: [],
      browserHolders: {},
      browserTabs: {},
      timelines: {},
      bots: [],
      browserTitles: {},
    };
  });

  it('全部空闲时不渲染', () => {
    expect(render()).toBe('');
  });

  it('只列非闲成员，委派在跑时附「名字 · 状态 · 短说明」', () => {
    store.state = { ...store.state, delegations: [delegation] };
    const html = render();
    expect(html).toContain('Jason · 思考 · 浏览器标签页锁');
    expect(html).not.toContain('Anran');
  });

  it.each(cases)(
    'renders $state consistently in chips and avatar accessibility/hover text',
    ({ state, zh, en, patch }) => {
      store.state = { ...store.state, ...patch };
      expect(presenceLabel({ state }, (key) => translate('zh', key))).toBe(zh);
      expect(presenceLabel({ state }, (key) => translate('en', key))).toBe(en);
      expect(renderToStaticMarkup(createElement(PresenceChip, { info: { state } }))).toContain(
        `${zh}</span>`
      );
      const html = renderToStaticMarkup(
        createElement(PresenceAvatar, {
          chatId: 'chat1',
          botId: state === 'think' ? 'b1' : 'b2',
          bot: bots.get('b2'),
        })
      );
      expect(html).toContain(`class="sr-only">${zh}</span>`);
      expect(html.split('data-testid="hover-details"')[1]).toContain(`${zh}</span>`);
    }
  );

  it.each(['approval', 'ask'] as const)('keeps the %s reason beside the waiting label', (kind) => {
    store.state = {
      ...store.state,
      sessions: {
        c2: session(
          kind === 'approval'
            ? {
                pendingApprovals: [
                  { requestId: 'a', tool: 'bash', kind: 'command', summary: 'pnpm test' },
                ],
              }
            : { pendingAsks: [{ requestId: 'q', question: 'Which?' }] }
        ),
      },
    };
    const html = render();
    expect(html).toContain('Anran · 等待');
    expect(html).toContain(kind === 'approval' ? '你批准：pnpm test' : '你回答：Which?');
    expect(html).toContain('去处理');
  });

  it('uses the shared label on active delegation cards without changing English or queued labels', () => {
    const card = () =>
      renderToStaticMarkup(
        createElement(DelegationCard, {
          record: delegation,
          bots,
          onOpenConversation: () => {},
        })
      );
    expect(card()).toContain('思考</span>');
    store.locale = 'en';
    expect(card()).toContain('Planning</span>');
    expect(
      presenceLabel({ state: 'think', wait: { kind: 'capacity' } }, (key) => translate('zh', key))
    ).toBe('排队中');
  });
});
