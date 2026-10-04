import { type Locale, translate } from '@shared/i18n';
import type { AgentSessionCustomEntry } from '@shared/types/agent';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { applyAgentEvent, emptyProjection } from '@/stores/sessions/reducer';
import { buildTimeline } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

const harness = vi.hoisted(() => ({ locale: 'en' as Locale }));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      translate(harness.locale, key, params),
  }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select({}),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('./Markdown', () => ({ Markdown: () => null }));
vi.mock('./EditDiff', () => ({ EditDiff: () => null }));
vi.mock('./ReadFileView', () => ({ ReadFileView: () => null }));

const first: AgentSessionCustomEntry = {
  kind: 'oauth-account-selected',
  accountKey: 'openai-codex#2',
  at: 20,
};
const switched: AgentSessionCustomEntry = {
  kind: 'oauth-account-selected',
  accountKey: 'openai-codex#3',
  previousAccountKey: 'openai-codex#2',
  at: 30,
};

describe('ChatGPT 实际账号通知', () => {
  it.each([
    { locale: 'en' as const, entry: first, text: 'ChatGPT account selected: openai-codex#2' },
    { locale: 'zh' as const, entry: first, text: '已选择 ChatGPT 账号：openai-codex#2' },
    {
      locale: 'en' as const,
      entry: switched,
      text: 'ChatGPT account switched: openai-codex#2 → openai-codex#3',
    },
    {
      locale: 'zh' as const,
      entry: switched,
      text: 'ChatGPT 账号已接替：openai-codex#2 → openai-codex#3',
    },
  ])('首次选择与接替提示显示真实账号，支持 $locale：$text', ({ locale, entry, text }) => {
    harness.locale = locale;
    const html = renderToStaticMarkup(
      createElement(TimelineRow, { item: { kind: 'session-custom', key: 'account', entry } })
    );
    expect(html).toContain(text);
    expect(html).not.toContain('{{');
  });

  it('账号事件与正文按时间归并，重复或过期 seq 不新增通知，也不进入模型消息', () => {
    const identity = { sessionId: 'session', generation: 'generation' };
    const before = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'before' }],
      timestamp: 10,
    };
    const after = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'after' }],
      timestamp: 40,
    };
    const selectedEvent = { type: 'session-custom-entry' as const, identity, seq: 1, entry: first };
    const selected = applyAgentEvent(
      { ...emptyProjection, messages: [before, after] },
      identity.sessionId,
      selectedEvent
    );
    const rotated = applyAgentEvent(selected, identity.sessionId, {
      ...selectedEvent,
      seq: 2,
      entry: switched,
    });
    expect(applyAgentEvent(rotated, identity.sessionId, selectedEvent)).toBe(rotated);
    expect(
      applyAgentEvent(rotated, identity.sessionId, { ...selectedEvent, seq: 2, entry: switched })
    ).toBe(rotated);
    expect(rotated.messages).toEqual([before, after]);

    const timeline = buildTimeline(rotated.messages, false, rotated.customEntries);
    expect(timeline.map((item) => item.kind)).toEqual([
      'user',
      'session-custom',
      'session-custom',
      'text',
    ]);
    expect(timeline.slice(1, 3)).toMatchObject([{ entry: first }, { entry: switched }]);
    expect(new Set(timeline.map((item) => item.key)).size).toBe(timeline.length);
    expect(
      buildTimeline(rotated.messages, false, rotated.customEntries).map((item) => item.key)
    ).toEqual(timeline.map((item) => item.key));
  });

  it('历史快照恢复首次与接替通知，无需读取池锚点或账号凭据', () => {
    harness.locale = 'zh';
    const restored = applyAgentEvent(emptyProjection, 'session', {
      type: 'snapshot',
      sessions: [
        {
          identity: { sessionId: 'session', generation: 'restored' },
          status: 'idle',
          messages: [],
          commands: [],
          customEntries: [first, switched],
        },
      ],
    });
    const timeline = buildTimeline(restored.messages, false, restored.customEntries);
    const html = timeline
      .map((item) => renderToStaticMarkup(createElement(TimelineRow, { item })))
      .join('');
    expect(html).toContain('已选择 ChatGPT 账号：openai-codex#2');
    expect(html).toContain('ChatGPT 账号已接替：openai-codex#2 → openai-codex#3');
    expect(restored.messages).toEqual([]);
  });
});
