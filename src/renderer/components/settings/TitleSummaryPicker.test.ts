import type { ModelProvider } from '@shared/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TitleSummaryPicker } from './TitleSummaryPicker';

const providers: ModelProvider[] = [
  {
    id: 'api',
    name: 'API entry',
    api: 'openai-completions',
    apiKey: 'secret',
    baseUrl: 'https://example.test/v1',
    enabled: true,
    models: [{ id: 'model', label: 'Chosen model' }],
  },
];

const harness = vi.hoisted(() => ({
  state: {
    titleSummaryEnabled: true,
    titleSummaryModel: null as { providerId: string; modelId: string } | null,
  },
  setTitleSummaryEnabled: vi.fn(),
  setTitleSummaryModel: vi.fn(),
  pickerProps: null as Record<string, unknown> | null,
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      providers,
      titleSummaryEnabled: harness.state.titleSummaryEnabled,
      titleSummaryModel: harness.state.titleSummaryModel,
      setTitleSummaryEnabled: harness.setTitleSummaryEnabled,
      setTitleSummaryModel: harness.setTitleSummaryModel,
    }),
}));

vi.mock('@/stores/oauthCredentials', () => ({
  useOauthCredentialStore: (
    selector: (state: {
      snapshot: {
        revision: number;
        availability: { status: 'ready'; authenticatedAccountKeys: ReadonlySet<string> };
      };
    }) => unknown
  ) =>
    selector({
      snapshot: {
        revision: 1,
        availability: { status: 'ready', authenticatedAccountKeys: new Set() },
      },
    }),
  usableProvidersForOauthSnapshot: (entries: ModelProvider[]) => entries,
}));

vi.mock('@/components/chat/ModelPicker', () => ({
  ModelPicker: (props: Record<string, unknown>) => {
    harness.pickerProps = props;
    return createElement('i', {
      'data-title-picker': 'true',
      'data-reasoning-controls': String(props.showReasoningControls),
    });
  },
}));

describe('TitleSummaryPicker', () => {
  it('开启时展示模型选择（无 reasoning 控件），未选独立模型时提示跟随全局默认', () => {
    harness.state.titleSummaryEnabled = true;
    harness.state.titleSummaryModel = null;
    const html = renderToStaticMarkup(createElement(TitleSummaryPicker));
    expect(html).toContain('data-title-picker="true"');
    // 标题总结不需要推理档位：必须显式关掉级联菜单里的 reasoning 控件
    expect(html).toContain('data-reasoning-controls="false"');
    expect(html).toContain('Follows the default model');

    const onSelect = harness.pickerProps?.onSelect;
    if (typeof onSelect === 'function') onSelect('api', 'model');
    expect(harness.setTitleSummaryModel).toHaveBeenCalledWith({
      providerId: 'api',
      modelId: 'model',
    });
  });

  it('已选独立模型时展示模型名与「跟随默认」重置入口', () => {
    harness.state.titleSummaryEnabled = true;
    harness.state.titleSummaryModel = { providerId: 'api', modelId: 'model' };
    const html = renderToStaticMarkup(createElement(TitleSummaryPicker));
    expect(html).toContain('Chosen model');
    expect(html).toContain('Follow default model');
  });

  it('关闭时不渲染模型选择行', () => {
    harness.state.titleSummaryEnabled = false;
    harness.state.titleSummaryModel = null;
    harness.pickerProps = null;
    const html = renderToStaticMarkup(createElement(TitleSummaryPicker));
    expect(html).not.toContain('data-title-picker');
    expect(harness.pickerProps).toBeNull();
  });
});
