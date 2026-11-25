import type { AgentTypeEntry, ModelProvider, Preset, SubagentModelEntry } from '@shared/types';
import type { VirtualModelEntry } from '@shared/virtualModels';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { setupPin } from './pin.testUtils';

// 模型菜单是弹层，钉子里换成按「供应商/模型」列出的选项，记录选中项与点选写入
vi.mock('@/components/chat/ModelPicker', () => ({
  MODEL_PICKER_DIALOG_TRIGGER_CLASS: 'form-trigger',
  MODEL_PICKER_FORM_TRIGGER_CLASS: 'form-trigger',
  ModelPicker: ({
    providers,
    providerId,
    modelId,
    onSelect,
  }: {
    providers: ModelProvider[];
    providerId: string;
    modelId: string;
    onSelect: (providerId: string, modelId: string) => void;
  }) => (
    <div data-pin="select">
      {providers.flatMap((provider) =>
        provider.models.map((model) => (
          <button
            key={`${provider.id}/${model.id}`}
            type="button"
            role="option"
            aria-selected={provider.id === providerId && model.id === modelId}
            onClick={() => onSelect(provider.id, model.id)}
          />
        ))
      )}
    </div>
  ),
}));

const PROVIDERS: ModelProvider[] = [
  {
    id: 'api',
    name: 'API entry',
    api: 'openai-completions',
    apiKey: 'secret',
    baseUrl: 'https://example.test/v1',
    enabled: true,
    models: [
      { id: 'fast', label: 'Fast', enabled: true },
      { id: 'smart', label: 'Smart', enabled: true },
    ],
  },
  {
    id: 'off',
    name: 'Disabled entry',
    api: 'anthropic-messages',
    apiKey: 'secret',
    baseUrl: 'https://other.test',
    enabled: false,
    models: [{ id: 'claude', enabled: true }],
  },
];
const VIRTUAL: VirtualModelEntry[] = [
  {
    id: 'auto',
    name: 'Auto',
    enabled: true,
    primary: { providerId: 'api', modelId: 'smart' },
    fast: { providerId: 'api', modelId: 'fast' },
    fallbacks: [{ providerId: 'api', modelId: 'fast' }],
  },
];
const SUBAGENT: SubagentModelEntry[] = [
  { id: 'sub', providerId: 'api', modelId: 'fast', description: 'cheap' },
];
const PRESETS: Preset[] = [
  { id: 'default', name: 'Default', skillIds: [], mcpServerIds: [] },
  { id: 'p1', name: 'Writer', skillIds: [], mcpServerIds: [], refusalRetry: true },
];
const AGENTS: AgentTypeEntry[] = [
  {
    id: 'a1',
    name: 'helper',
    description: 'Helps',
    systemPrompt: 'be nice',
    modelMode: 'fixed',
    providerId: 'api',
    modelId: 'fast',
    tools: 'readonly',
  },
];

/**
 * 迁移时只改这里：分区 → 页面组件。import 顶层并行发起：顺序瀑布在高负载下要
 * 十几秒，会撑爆 beforeAll 的 10s 超时；顶层 await 属于模块求值，不进钩子计时。
 */
const MODELS_GROUP_PAGES = await (async () => {
  const { useSettingsStore } = await import('@/stores/settings');
  useSettingsStore.setState({
    providers: PROVIDERS,
    virtualModels: VIRTUAL,
    defaultModel: { providerId: 'api', modelId: 'smart' },
    defaultModelFollowLast: false,
    titleSummaryEnabled: true,
    titleSummaryModel: { providerId: 'api', modelId: 'fast' },
    gitCommitModel: { providerId: 'api', modelId: 'fast' },
    subagentModelsEnabled: true,
    subagentModels: SUBAGENT,
    presets: PRESETS,
    agentTypes: AGENTS,
  });
  const [{ ProvidersSettings }, { PresetsSettings }, { AgentTypesSettings }] = await Promise.all([
    import('./ProvidersSettings'),
    import('./PresetsSettings'),
    import('./AgentTypesSettings'),
  ]);
  return { providers: ProvidersSettings, presets: PresetsSettings, agents: AgentTypesSettings };
})();

const pin = setupPin({
  pages: () => MODELS_GROUP_PAGES,
  results: {
    'electronAPI.providers.listOauth': [],
    'electronAPI.providers.classifierModels': { ok: true, models: [] },
    'electronAPI.git.readCommitPrompt': { ok: true, custom: false, text: '' },
    'electronAPI.presets.readSystemPrompt': { ok: true, text: '' },
    'electronAPI.sourceAuthority.read': { projects: [], conversations: [] },
    'electronAPI.extensionPlugins.list': [],
  },
});

describe('模型与服务商组设置迁移前后行为一致', () => {
  it('每页都渲染出来了', () => {
    const empty = [...pin.container.querySelectorAll('[data-pin-page]')]
      .filter((page) => (page.textContent ?? '').trim() === '')
      .map((page) => page.getAttribute('data-pin-page'));
    expect(empty).toEqual([]);
  });

  it('深链行 id 一个不少', () => {
    expect(pin.rows()).toMatchSnapshot();
  });

  // 逐个点控件较慢，机器忙时 5s 默认超时不够（与其他 pin 组一致）
  it('每个控件的当前值（默认值）与读写的 store key / electronAPI 调用不变', async () => {
    expect(await pin.probe()).toMatchSnapshot();
  }, 30_000);

  it('关掉标题总结与子代理模型后同样不变', async () => {
    await act(async () =>
      pin.store.setState({ titleSummaryEnabled: false, subagentModelsEnabled: false })
    );
    await pin.settle();
    expect(await pin.probe()).toMatchSnapshot();
  }, 30_000);
});
