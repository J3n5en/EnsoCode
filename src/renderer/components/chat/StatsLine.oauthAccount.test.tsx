import type { ModelProvider } from '@shared/types';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { emptyProjection } from '@/stores/sessions/reducer';
import { StatsLine } from './StatsLine';

const harness = vi.hoisted(() => ({
  conversation: {} as object,
  providers: [] as ModelProvider[],
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: object) => unknown) =>
    select({ conversations: { fixture: harness.conversation } }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) =>
    select({
      providers: harness.providers,
      virtualModels: [],
      projects: [],
      statusLineSegments: ['usage'],
    }),
}));
vi.mock('@/components/ui/popover', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return { Popover: Wrap, PopoverPopup: Wrap, PopoverTrigger: Wrap };
});
vi.mock('./ContextInspector', () => ({ ContextInspector: () => null }));
vi.mock('./ContextMeter', () => ({ ContextMeter: () => null }));
vi.mock('./StatusLineSettings', () => ({ StatusLineSettings: () => null }));
vi.mock('@/hooks/useAccountUsage', () => ({
  fetchAccountUsage: vi.fn(),
  USAGE_CACHE_TTL_MS: 60_000,
  usageCache: new Map([
    [
      'openai-codex',
      { fetchedAt: Date.now(), data: { windows: [{ label: 'Anchor', usedPercent: 12 }] } },
    ],
    [
      'openai-codex#2',
      { fetchedAt: Date.now(), data: { windows: [{ label: 'Actual', usedPercent: 73 }] } },
    ],
  ]),
}));

describe('状态栏池额度身份', () => {
  it('与选择器共用实际scope账号，未知或换池隐藏，普通账号仍用自身', () => {
    const pool: ModelProvider = {
      id: 'pool',
      name: 'ChatGPT',
      api: 'openai-responses',
      baseUrl: '',
      apiKey: '',
      enabled: true,
      oauthAccountKey: 'openai-codex',
      oauthAccountPool: { accountKeys: ['openai-codex', 'openai-codex#2'] },
      models: [{ id: 'model' }],
    };
    const conversation = {
      ...emptyProjection,
      id: 'fixture',
      projectId: '',
      title: '',
      started: true,
      spawning: false,
      createdAt: 1,
      lastProviderId: 'pool',
      lastModelId: 'model',
      customEntries: [
        {
          kind: 'oauth-account-selected',
          settingsProviderId: 'pool',
          modelId: 'model',
          accountKey: 'openai-codex#2',
          at: 10,
        },
      ],
    };
    harness.providers = [pool];
    harness.conversation = conversation;
    const render = () =>
      renderToStaticMarkup(createElement(StatsLine, { conversationId: 'fixture' }));
    expect(render()).toContain('Actual 73%');
    expect(render()).not.toContain('Anchor 12%');
    harness.conversation = { ...conversation, customEntries: [] };
    expect(render()).not.toContain('12%');
    harness.conversation = { ...conversation, lastProviderId: 'other' };
    harness.providers = [pool, { ...pool, id: 'other' }];
    expect(render()).not.toContain('73%');
    harness.conversation = conversation;
    harness.providers = [{ ...pool, oauthAccountPool: undefined }];
    expect(render()).toContain('Anchor 12%');
  });
});
