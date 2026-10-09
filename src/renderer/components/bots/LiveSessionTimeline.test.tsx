import { translate } from '@shared/i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LiveSessionTimeline } from './LiveSessionTimeline';

vi.mock('@/stores/bots', () => ({
  useBotsStore: Object.assign(
    (select: (state: unknown) => unknown) => select({ sessions: {}, sessionHistoryLoading: {} }),
    { getState: () => ({}) }
  ),
}));
vi.mock('@/components/chat/MessageTimeline', () => ({
  CHAT_COL: 'chat-col',
  MessageTimeline: () => createElement('div', { 'data-testid': 'timeline' }),
}));
vi.mock('@/components/chat/RetryBar', () => ({ RetryBar: () => null }));
// 组件引入了 useI18n（委派多次执行分隔线），真实 i18n 会连带加载依赖 window 的设置 store
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => translate('en', key, params),
  }),
}));

const render = (props: { dataSlot?: string } = {}) =>
  renderToStaticMarkup(
    createElement(LiveSessionTimeline, {
      conversationId: 'k1',
      speaker: { name: 'Jason', color: '#888' },
      emptyTitle: 'hi',
      ...props,
    })
  );

describe('LiveSessionTimeline card scope', () => {
  it('marks the DM timeline column so its bot cards follow the composer opacity', () => {
    expect(render({ dataSlot: 'bot-timeline' })).toMatch(/^<div data-slot="bot-timeline"/u);
  });

  it('leaves other hosts (live session dialog) unscoped, cards stay transparent', () => {
    expect(render()).not.toContain('data-slot');
  });
});
