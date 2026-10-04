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
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ providers: harness.providers, updateProvider: harness.updateProvider }),
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
    expect(harness.updateProvider.mock.calls).toEqual([
      ['pool', { models: fixed.models, oauthAccountPool: { accountKeys: ['openai-codex'] } }],
    ]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
