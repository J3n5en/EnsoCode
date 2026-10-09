import { translate } from '@shared/i18n';
import type { BotProfile, Delegation } from '@shared/types/bot';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegationCard } from './DelegationCard';

const store = vi.hoisted(() => ({
  locale: 'zh' as 'zh' | 'en',
  state: { delegations: [], sessions: {}, queue: [], silences: [] } as Record<string, unknown>,
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

const bots = new Map([
  ['boss', { id: 'boss', name: '林经理', avatar: { color: '#888' } } as BotProfile],
  ['b1', { id: 'b1', name: 'Jason', avatar: { color: '#888' } } as BotProfile],
]);
const record = {
  id: 'd1',
  chatId: 'chat1',
  parentBotId: 'boss',
  targetBotId: 'b1',
  task: '断网提示条',
  childConversationId: 'k1',
  state: 'running',
  createdAt: Date.now() - 60_000,
  taskId: 't42',
  appends: [{ at: Date.now(), text: '顺便加个重连按钮', deliveryId: 'x1' }],
} as Delegation;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = (taskSeq?: number) =>
  text(
    renderToStaticMarkup(
      createElement(DelegationCard, {
        record,
        append: record.appends?.[0],
        taskSeq,
        bots,
        onOpenConversation: () => {},
      })
    )
  );

describe('DelegationCard 并入的追加', () => {
  beforeEach(() => {
    store.locale = 'zh';
  });

  it('显示「已并入 #N 当前执行」与追加内容，不显示状态与取消', () => {
    const html = render(42);
    expect(html).toContain('林经理 → Jason');
    expect(html).toContain('已并入 #42 当前执行');
    expect(html).toContain('顺便加个重连按钮');
    expect(html).not.toContain('断网提示条');
    for (const label of ['进行中', '排队', '取消']) expect(html).not.toContain(label);
    expect(html).toContain('查看过程');
  });

  it('不知道任务号时只写并入当前执行；英文文案', () => {
    expect(render()).toContain('已并入当前执行');
    store.locale = 'en';
    expect(render(42)).toContain('Merged into the current run of #42');
    expect(render()).toContain('Merged into the current run');
  });
});

const bot = (id: string, name: string) => ({ id, name, avatar: { color: '#888' } }) as BotProfile;
const wideBots = new Map([
  ['boss', bot('boss', 'A-very-long-member-name-that-should-not-push-the-card-wider')],
  ['b1', bot('b1', 'Jason')],
]);
const wideRecord = {
  id: 'd1',
  chatId: 'chat1',
  parentBotId: 'boss',
  targetBotId: 'b1',
  task: 'https://example.com/an/unbroken/very/long/path/that/must/wrap/anywhere/inside/the/card',
  childConversationId: 'k1',
  state: 'running',
  createdAt: 1,
} as Delegation;

const renderWide = (props: { fill?: boolean } = {}, patch: Partial<Delegation> = {}) =>
  renderToStaticMarkup(
    createElement(DelegationCard, {
      record: { ...wideRecord, ...patch },
      bots: wideBots,
      onOpenConversation: () => {},
      ...props,
    })
  );

/** 取紧挨着 marker 之前那个标签的 class 列表 */
const classesBefore = (html: string, marker: string): string[] => {
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const tags = html.slice(0, at).match(/class="[^"]*"/gu);
  return tags?.at(-1)?.slice(7, -1).split(' ') ?? [];
};
const rootClasses = (html: string) => html.match(/^<div[^>]*class="([^"]*)"/u)?.[1].split(' ');

describe('DelegationCard width', () => {
  beforeEach(() => {
    store.locale = 'en';
    store.state = { delegations: [], sessions: {}, queue: [], silences: [] };
  });

  it('keeps the compact width cap by default (group board, DM strip)', () => {
    expect(rootClasses(renderWide())).toContain('max-w-lg');
  });

  it('fills the chat column in the timeline, same width as the composer', () => {
    const root = rootClasses(renderWide({ fill: true }));
    expect(root).not.toContain('max-w-lg');
    expect(root).toContain('w-full');
    expect(root).toContain('min-w-0');
  });

  it('lets long names, unbroken task text and the button row shrink or wrap', () => {
    const html = renderWide({ fill: true }, { state: 'failed', failure: 'interrupted' });
    const name = classesBefore(html, 'A-very-long-member-name');
    expect(name).toContain('truncate');
    expect(name).toContain('min-w-0');
    expect(classesBefore(html, 'https://example.com')).toContain('[overflow-wrap:anywhere]');
    expect(classesBefore(html, '<button')).toContain('flex-wrap');
  });
});
