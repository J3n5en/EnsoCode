import { type Locale, translate } from '@shared/i18n';
import type { AgentSessionCustomEntry } from '@shared/types/agent';
import type { OauthAccount, OauthProviderInfo } from '@shared/types/oauthProviders';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginOauthCredentialRefresh } from '@/stores/oauthCredentials';
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

const accounts: OauthAccount[] = [
  { key: 'openai-codex#2', providerId: 'openai-codex', email: 'first@example.test' },
  { key: 'openai-codex#3', providerId: 'openai-codex', email: 'second@example.test' },
];
const metadata = (items: OauthAccount[] = accounts): OauthProviderInfo[] => [
  {
    id: 'openai-codex',
    name: 'ChatGPT',
    supportsMultipleAccounts: true,
    accounts: items,
    models: [],
  },
];

let root: Root | undefined;
beforeEach(() => {
  harness.locale = 'en';
  beginOauthCredentialRefresh();
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountEntries(
  entries: AgentSessionCustomEntry[],
  listOauth = vi.fn<() => Promise<OauthProviderInfo[]>>().mockResolvedValue(metadata())
) {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('electronAPI', { providers: { listOauth } });
  const container = dom.document.getElementById('root');
  if (!container) throw new Error('Missing test root');
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        'div',
        null,
        ...entries.map((entry, index) =>
          createElement(TimelineRow, {
            key: index,
            item: { kind: 'session-custom', key: `account-${index}`, entry },
          })
        )
      )
    );
  });
  return { text: () => container.textContent ?? '', listOauth };
}

describe('ChatGPT 实际账号通知', () => {
  it.each([
    { locale: 'en' as const, entry: first, text: 'ChatGPT account selected: first@example.test' },
    { locale: 'zh' as const, entry: first, text: '已选择 ChatGPT 账号：first@example.test' },
    {
      locale: 'en' as const,
      entry: switched,
      text: 'ChatGPT account switched: first@example.test → second@example.test',
    },
    {
      locale: 'zh' as const,
      entry: switched,
      text: 'ChatGPT 账号已接替：first@example.test → second@example.test',
    },
  ])('首次选择与接替提示显示邮箱，支持 $locale：$text', async ({ locale, entry, text }) => {
    harness.locale = locale;
    const ui = await mountEntries([entry]);
    expect(ui.text()).toBe(text);
    expect(ui.text()).not.toContain('openai-codex');
  });

  it.each([
    {
      locale: 'en' as const,
      selected: 'ChatGPT account selected',
      switched: 'ChatGPT account switched',
    },
    { locale: 'zh' as const, selected: '已选择 ChatGPT 账号', switched: 'ChatGPT 账号已接替' },
  ])('缺少、空白邮箱或未知账号只显示通用提示，不拿key冒充邮箱（$locale）', async (expected) => {
    harness.locale = expected.locale;
    const listOauth = vi.fn<() => Promise<OauthProviderInfo[]>>().mockResolvedValue(
      metadata([
        { key: 'openai-codex#2', providerId: 'openai-codex' },
        { key: 'openai-codex#3', providerId: 'openai-codex', email: '  \n\t ' },
      ])
    );
    const ui = await mountEntries(
      [first, switched, { ...first, accountKey: 'openai-codex' }],
      listOauth
    );
    expect(ui.text()).toBe(`${expected.selected}${expected.switched}${expected.selected}`);
  });

  it('切换的任一端缺邮箱时显示通用提示，不拼接账号key', async () => {
    const ui = await mountEntries([
      { ...switched, previousAccountKey: 'openai-codex#99' },
      { ...switched, accountKey: 'openai-codex#99' },
    ]);
    expect(ui.text()).toBe('ChatGPT account switchedChatGPT account switched');
  });

  it('凭证revision变化刷新邮箱，旧响应和卸载后响应不会覆盖界面', async () => {
    let resolveOld!: (infos: OauthProviderInfo[]) => void;
    let resolveUnmounted!: (infos: OauthProviderInfo[]) => void;
    const listOauth = vi
      .fn<() => Promise<OauthProviderInfo[]>>()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        })
      )
      .mockResolvedValueOnce(
        metadata([{ key: first.accountKey, providerId: 'openai-codex', email: 'new@example.test' }])
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveUnmounted = resolve;
        })
      );
    const ui = await mountEntries([first], listOauth);
    expect(ui.text()).toBe('ChatGPT account selected');
    await act(async () => {
      beginOauthCredentialRefresh();
    });
    expect(ui.text()).toBe('ChatGPT account selected: new@example.test');
    await act(async () => {
      resolveOld(metadata());
    });
    expect(ui.text()).toBe('ChatGPT account selected: new@example.test');
    await act(async () => {
      beginOauthCredentialRefresh();
    });
    expect(ui.text()).toBe('ChatGPT account selected');
    await act(async () => {
      root?.unmount();
    });
    root = undefined;
    await act(async () => {
      resolveUnmounted(metadata());
    });
    expect(ui.text()).toBe('');
  });

  it('查询失败可见降级为通用通知，并清除过期邮箱', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listOauth = vi
      .fn<() => Promise<OauthProviderInfo[]>>()
      .mockResolvedValueOnce(metadata())
      .mockRejectedValueOnce(new Error('metadata unavailable'));
    const ui = await mountEntries([first], listOauth);
    expect(ui.text()).toBe('ChatGPT account selected: first@example.test');
    await act(async () => {
      beginOauthCredentialRefresh();
    });
    expect(ui.text()).toBe('ChatGPT account selected');
    expect(error).toHaveBeenCalled();
  });

  it('邮箱只作为React文本渲染且去除控制字符', async () => {
    const ui = await mountEntries(
      [first],
      vi.fn<() => Promise<OauthProviderInfo[]>>().mockResolvedValue(
        metadata([
          {
            key: first.accountKey,
            providerId: 'openai-codex',
            email: ' \nfirst\t@example.test\u007f ',
          },
        ])
      )
    );
    expect(ui.text()).toBe('ChatGPT account selected: first@example.test');
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

  it('历史快照恢复首次与接替通知，多个通知只查询一次脱敏元数据', async () => {
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
    const entries = timeline.flatMap((item) =>
      item.kind === 'session-custom' ? [item.entry] : []
    );
    const ui = await mountEntries(entries);
    expect(ui.text()).toContain('已选择 ChatGPT 账号：first@example.test');
    expect(ui.text()).toContain('ChatGPT 账号已接替：first@example.test → second@example.test');
    expect(ui.listOauth).toHaveBeenCalledTimes(1);
    expect(restored.messages).toEqual([]);
  });
});
