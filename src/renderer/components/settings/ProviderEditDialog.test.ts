import type { ModelProvider, OauthAccount, OauthProviderInfo } from '@shared/types';
import { parseHTML } from 'linkedom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderEditDialog } from './ProviderEditDialog';

const harness = vi.hoisted(() => ({
  providers: [] as ModelProvider[],
  formProps: {} as Record<string, unknown>,
  updateProvider: vi.fn(),
  oauthRevision: 0,
  defaultModel: null as { providerId: string; modelId: string } | null,
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ providers: harness.providers, updateProvider: harness.updateProvider }),
    { getState: () => ({ defaultModel: harness.defaultModel, providers: harness.providers }) }
  ),
}));
vi.mock('@/stores/oauthCredentials', () => ({
  useOauthCredentialStore: (selector: (state: unknown) => unknown) =>
    selector({
      snapshot: {
        revision: harness.oauthRevision,
        availability: { status: 'ready', authenticatedAccountKeys: new Set(['openai-codex']) },
      },
    }),
}));
vi.mock('@/components/ui/dialog', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return { Dialog: Wrap, DialogContent: Wrap, DialogHeader: Wrap, DialogTitle: Wrap };
});
vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({ checked }: { checked: boolean }) =>
    createElement('input', { type: 'checkbox', checked, readOnly: true }),
}));
vi.mock('./ProviderApiForm', () => ({
  ProviderApiForm: (props: Record<string, unknown>) => {
    harness.formProps = props;
    return createElement('div', null, props.extraFields as ReactNode);
  },
}));

const fixed: ModelProvider = {
  id: 'fixed',
  name: 'Fixed account',
  api: 'openai-completions',
  apiKey: '',
  baseUrl: '',
  enabled: true,
  oauthAccountKey: 'openai-codex',
  models: [{ id: 'gpt-model', thinkingLevel: 'high', enabled: true }],
};

beforeEach(() => {
  harness.providers = [fixed];
  harness.formProps = {};
  harness.updateProvider.mockClear();
  harness.oauthRevision = 0;
  harness.defaultModel = null;
});

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function metadata(accounts: OauthAccount[]): OauthProviderInfo[] {
  return [
    {
      id: 'openai-codex',
      name: 'ChatGPT',
      supportsMultipleAccounts: true,
      accounts,
      models: [],
    },
  ];
}

describe('API key provider drafts', () => {
  it('透传已有代理，保存跟随全局时显式清掉 proxy；代理变化不补回后台新增模型', () => {
    const provider: ModelProvider = {
      ...fixed,
      oauthAccountKey: undefined,
      apiKey: 'test-key',
      baseUrl: 'https://chat.example/v1',
      proxy: { mode: 'custom', url: 'http://127.0.0.1:7890' },
    };
    harness.providers = [provider];
    renderToStaticMarkup(createElement(ProviderEditDialog, { provider, onClose: vi.fn() }));
    const initial = harness.formProps.initialValue as Record<string, unknown>;
    expect(initial.proxy).toEqual(provider.proxy);

    const added = { id: 'new-in-background', enabled: true };
    harness.providers = [{ ...provider, models: [...provider.models, added] }];
    const save = harness.formProps.onSave as (
      value: unknown,
      seenModelIds: ReadonlySet<string>
    ) => void;
    const seen = new Set(provider.models.map((model) => model.id));

    save({ ...initial, proxy: undefined }, seen);
    let patch = harness.updateProvider.mock.calls.at(-1)?.[1];
    expect(patch).toHaveProperty('proxy', undefined);
    expect(patch.models).toEqual(provider.models);

    save({ ...initial, proxy: { mode: 'custom', url: ' http://127.0.0.1:7890' } }, seen);
    patch = harness.updateProvider.mock.calls.at(-1)?.[1];
    expect(patch.models).toEqual([...provider.models, added]);

    save({ ...initial, proxy: { mode: 'none' } }, seen);
    patch = harness.updateProvider.mock.calls.at(-1)?.[1];
    expect(patch.proxy).toEqual({ mode: 'none' });
    expect(patch.models).toEqual(provider.models);
  });

  it.each([
    {
      initialEnabled: undefined,
      draftEnabled: false,
      concurrentEnabled: true,
      expected: undefined,
    },
    { initialEnabled: true, draftEnabled: true, concurrentEnabled: false, expected: undefined },
    { initialEnabled: undefined, draftEnabled: true, concurrentEnabled: false, expected: true },
    { initialEnabled: true, draftEnabled: false, concurrentEnabled: true, expected: false },
  ])(
    'only patches changed auto-fetch settings ($initialEnabled → $draftEnabled)',
    ({ initialEnabled, draftEnabled, concurrentEnabled, expected }) => {
      const provider = { ...fixed, oauthAccountKey: undefined, autoFetchModels: initialEnabled };
      const onClose = vi.fn();
      harness.providers = [provider];
      renderToStaticMarkup(createElement(ProviderEditDialog, { provider, onClose }));
      const initial = harness.formProps.initialValue as Record<string, unknown>;
      expect(initial.autoFetchModels).toBe(initialEnabled);

      harness.providers = [{ ...provider, autoFetchModels: concurrentEnabled }];
      (harness.formProps.onSave as (value: unknown, seenModelIds: ReadonlySet<string>) => void)(
        { ...initial, autoFetchModels: draftEnabled },
        new Set(provider.models.map((model) => model.id))
      );

      const [id, patch] = harness.updateProvider.mock.calls.at(-1) ?? [];
      expect(id).toBe(provider.id);
      if (expected === undefined) {
        expect(patch).not.toHaveProperty('autoFetchModels');
      } else {
        expect(patch.autoFetchModels).toBe(expected);
      }
      expect(onClose).toHaveBeenCalledOnce();
    }
  );

  it.each([
    { initialHours: undefined, draftHours: 1, expectedHours: undefined },
    { initialHours: 4, draftHours: 4, expectedHours: undefined },
    { initialHours: 4, draftHours: 1, expectedHours: 1 },
  ])(
    'only patches a changed interval ($initialHours → $draftHours)',
    ({ initialHours, draftHours, expectedHours }) => {
      const provider = {
        ...fixed,
        oauthAccountKey: undefined,
        modelRefreshIntervalHours: initialHours,
      };
      harness.providers = [provider];
      renderToStaticMarkup(createElement(ProviderEditDialog, { provider, onClose: vi.fn() }));
      const initial = harness.formProps.initialValue as Record<string, unknown>;
      expect(initial.modelRefreshIntervalHours).toBe(initialHours);

      const added = { id: 'new-in-background', enabled: true };
      harness.providers = [
        { ...provider, modelRefreshIntervalHours: 8, models: [...provider.models, added] },
      ];
      (harness.formProps.onSave as (value: unknown, seenModelIds: ReadonlySet<string>) => void)(
        { ...initial, name: 'Renamed', models: [], modelRefreshIntervalHours: draftHours },
        new Set(provider.models.map((model) => model.id))
      );

      const patch = harness.updateProvider.mock.calls.at(-1)?.[1];
      expect(patch).toMatchObject({ name: 'Renamed', models: [added] });
      if (expectedHours === undefined) {
        expect(patch).not.toHaveProperty('modelRefreshIntervalHours');
      } else {
        expect(patch.modelRefreshIntervalHours).toBe(expectedHours);
      }
    }
  );

  it.each([false, true])(
    'preserves unseen additions on save only when the endpoint is unchanged (%s)',
    (changeEndpoint) => {
      const provider: ModelProvider = {
        id: 'custom',
        name: 'Custom',
        api: 'openai-completions',
        apiKey: 'test-key',
        baseUrl: 'https://chat.example/v1',
        enabled: true,
        models: [{ id: 'manual' }, { id: 'removed-by-fetch' }],
      };
      harness.providers = [provider];
      renderToStaticMarkup(createElement(ProviderEditDialog, { provider, onClose: vi.fn() }));

      const added = { id: 'new-in-background', enabled: true };
      harness.providers = [
        {
          ...provider,
          models: [...provider.models, { id: 'seen-and-deleted' }, added],
          knownModelIds: ['manual', 'removed-by-fetch', 'seen-and-deleted', 'new-in-background'],
        },
      ];
      const draft = {
        ...provider,
        name: 'Renamed',
        baseUrl: changeEndpoint ? 'https://other.example/v1' : provider.baseUrl,
        models: [{ id: 'manual' }],
      };
      const seenModelIds = new Set(['manual', 'removed-by-fetch', 'seen-and-deleted']);
      (harness.formProps.onSave as (value: unknown, seenModelIds: ReadonlySet<string>) => void)(
        draft,
        seenModelIds
      );
      expect(harness.updateProvider.mock.calls.at(-1)).toEqual([
        provider.id,
        expect.objectContaining({
          name: 'Renamed',
          models: changeEndpoint ? draft.models : [...draft.models, added],
          // 草稿里删掉的模型记为已见，自动拉取不会加回
          knownModelIds: ['manual', 'removed-by-fetch', 'seen-and-deleted', 'new-in-background'],
        }),
      ]);
    }
  );
});

async function mountPool(listOauth: () => Promise<OauthProviderInfo[]>, accountKeys: string[]) {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('electronAPI', { providers: { listOauth } });
  const container = dom.document.getElementById('root');
  if (!container) throw new Error('Missing test root');
  root = createRoot(container);
  const provider = { ...fixed, id: 'pool', oauthAccountPool: { accountKeys } };
  const render = async (open = true) => {
    await act(async () => {
      root?.render(
        createElement(ProviderEditDialog, { provider: open ? provider : null, onClose: vi.fn() })
      );
    });
  };
  await render();
  return {
    render,
    labels: () =>
      Array.from(container.querySelectorAll('label > span.min-w-0')).map(
        (node) => node.textContent
      ),
    checked: () => Array.from(container.querySelectorAll('input')).map((node) => node.checked),
  };
}

describe('ChatGPT 池编辑边界', () => {
  it('按账号key显示当前邮箱而非存储旧名称，缺少邮箱或元数据时回退key且保持成员顺序和选择', async () => {
    harness.providers = [
      { ...fixed, name: 'Old stored name' },
      { ...fixed, id: 'second', name: 'Second old name', oauthAccountKey: 'openai-codex#2' },
    ];
    const ui = await mountPool(
      async () =>
        metadata([
          { key: 'openai-codex#2', providerId: 'openai-codex' },
          { key: 'openai-codex', providerId: 'openai-codex', email: 'current@example.test' },
          { key: 'openai-codex#3', providerId: 'openai-codex', email: 'other@example.test' },
        ]),
      ['openai-codex', 'openai-codex#4']
    );
    expect(ui.labels()).toEqual(['current@example.test', 'openai-codex#2', 'openai-codex#4']);
    expect(ui.checked()).toEqual([true, false, true]);
  });

  it('凭证revision刷新邮箱，晚到的旧响应不覆盖当前身份', async () => {
    let resolveOld!: (infos: OauthProviderInfo[]) => void;
    const listOauth = vi
      .fn<() => Promise<OauthProviderInfo[]>>()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        })
      )
      .mockResolvedValueOnce(
        metadata([{ key: 'openai-codex', providerId: 'openai-codex', email: 'new@example.test' }])
      );
    const ui = await mountPool(listOauth, ['openai-codex']);
    expect(ui.labels()).toEqual(['openai-codex']);
    harness.oauthRevision++;
    await ui.render();
    expect(ui.labels()).toEqual(['new@example.test']);
    await act(async () =>
      resolveOld(
        metadata([{ key: 'openai-codex', providerId: 'openai-codex', email: 'old@example.test' }])
      )
    );
    expect(ui.labels()).toEqual(['new@example.test']);
  });

  it('元数据刷新失败回退key，不保留过期邮箱或阻止保存', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const listOauth = vi
      .fn<() => Promise<OauthProviderInfo[]>>()
      .mockResolvedValueOnce(
        metadata([{ key: 'openai-codex', providerId: 'openai-codex', email: 'old@example.test' }])
      )
      .mockRejectedValueOnce(new Error('Metadata unavailable'));
    const ui = await mountPool(listOauth, ['openai-codex']);
    expect(ui.labels()).toEqual(['old@example.test']);
    harness.oauthRevision++;
    await ui.render();
    expect(ui.labels()).toEqual(['openai-codex']);
    expect(harness.formProps.saveDisabled).toBe(false);
  });

  it('关闭后晚到的元数据不会影响重新打开的账号身份', async () => {
    let resolveOld!: (infos: OauthProviderInfo[]) => void;
    const listOauth = vi
      .fn<() => Promise<OauthProviderInfo[]>>()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        })
      )
      .mockResolvedValueOnce(
        metadata([
          { key: 'openai-codex', providerId: 'openai-codex', email: 'reopened@example.test' },
        ])
      );
    const ui = await mountPool(listOauth, ['openai-codex']);
    await ui.render(false);
    await ui.render();
    await act(async () =>
      resolveOld(
        metadata([
          { key: 'openai-codex', providerId: 'openai-codex', email: 'closed@example.test' },
        ])
      )
    );
    expect(ui.labels()).toEqual(['reopened@example.test']);
  });

  it('未选择成员时禁用保存，且不能将空池写入设置或关闭弹窗', () => {
    const onClose = vi.fn();
    renderToStaticMarkup(
      createElement(ProviderEditDialog, {
        provider: { ...fixed, id: 'pool', oauthAccountPool: { accountKeys: [] } },
        onClose,
      })
    );
    expect(harness.formProps.saveDisabled).toBe(true);
    (harness.formProps.onSave as (value: unknown) => void)({ models: fixed.models });
    expect(harness.updateProvider).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('保存非空池只更新成员和模型，不覆盖固定账号或推理设置', () => {
    const onClose = vi.fn();
    renderToStaticMarkup(
      createElement(ProviderEditDialog, {
        provider: { ...fixed, id: 'pool', oauthAccountPool: { accountKeys: ['openai-codex'] } },
        onClose,
      })
    );
    expect(harness.formProps.saveDisabled).toBe(false);
    (harness.formProps.onSave as (value: unknown) => void)({ models: fixed.models });
    // 稀疏契约：thinkingLevel 是用户意图保留；enabled:true 与缺省等价被剥离
    expect(harness.updateProvider.mock.calls).toEqual([
      [
        'pool',
        {
          models: [{ id: 'gpt-model', thinkingLevel: 'high' }],
          oauthAccountPool: { accountKeys: ['openai-codex'] },
        },
      ],
    ]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
