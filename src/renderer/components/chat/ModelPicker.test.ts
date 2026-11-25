import type { ProviderGroup } from '@shared/providerGroups';
import { pushRecentModel } from '@shared/recentModels';
import type {
  ModelEntry,
  ModelMeta,
  ModelProvider,
  ModelRef,
  OauthAccountUsage,
  ThinkingLevel,
} from '@shared/types';
import { VIRTUAL_PROVIDER_ID, type VirtualModelEntry } from '@shared/virtualModels';
import { parseHTML } from 'linkedom';
import { act, createElement, type ReactNode, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetProviderFetchStates } from '@/components/settings/providerFetch';
import { Select, SelectTrigger } from '@/components/ui/select';
import {
  centeredScrollTop,
  duplicateModelLabels,
  expandWorkbenchGroups,
  MODEL_PICKER_DIALOG_TRIGGER_CLASS,
  MODEL_PICKER_FORM_TRIGGER_CLASS,
  ModelPicker,
  persistClampedThinkingLevel,
  pinnedModelKey,
  resolveActiveWorkbenchView,
  resolvePickerCapabilities,
} from './ModelPicker';

interface WrapperProps {
  children?: ReactNode;
}

interface ClickWrapperProps extends WrapperProps {
  onClick?: () => void;
}

const harness = vi.hoisted(() => ({
  menuItemClicks: [] as Array<() => void>,
  menuOpen: false,
  deferPopup: false,
  menuOnOpenChange: undefined as
    | ((open: boolean, details?: { cancel: () => void; allowPropagation: () => void }) => void)
    | undefined,
  switchProps: null as Record<string, unknown> | null,
  buttons: [] as Record<string, unknown>[],
  meta: {} as Record<string, unknown>,
  usageAccountKeys: [] as string[],
  usageData: {} as Record<string, OauthAccountUsage>,
  pinnedModels: [] as string[],
  recentModels: [] as ModelRef[],
  togglePinnedModel: vi.fn(),
  recordRecentModel: vi.fn(),
  removeRecentModel: vi.fn(),
  providers: [] as ModelProvider[],
  updateProvider: vi.fn(),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      Object.entries(params ?? {}).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
        key
      ),
  }),
}));

vi.mock('@/stores/modelMeta', () => ({
  useModelMeta: () => harness.meta,
  invalidateModelMeta: vi.fn(),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: <T>(
    selector: (state: {
      pinnedModels: string[];
      togglePinnedModel: (key: string) => void;
      recentModels: ModelRef[];
      recordRecentModel: (ref: ModelRef) => void;
      removeRecentModel: (ref: ModelRef) => void;
      providers: ModelProvider[];
      updateProvider: (id: string, patch: { models: ModelEntry[] }) => void;
    }) => T
  ) =>
    selector({
      pinnedModels: harness.pinnedModels,
      togglePinnedModel: harness.togglePinnedModel,
      recentModels: harness.recentModels,
      recordRecentModel: harness.recordRecentModel,
      removeRecentModel: harness.removeRecentModel,
      providers: harness.providers,
      updateProvider: harness.updateProvider,
    }),
}));

vi.mock('@/hooks/useAccountUsage', () => ({
  prefetchAccountUsage: vi.fn(),
  useCachedAccountUsage: (key: string) => {
    harness.usageAccountKeys.push(key);
    return harness.usageData[key];
  },
}));

vi.mock('@/components/ui/menu', () => {
  const Wrap = ({ children }: WrapperProps) => createElement('div', null, children);
  const Menu = ({
    children,
    open,
    onOpenChange,
  }: WrapperProps & {
    open?: boolean;
    onOpenChange?: (
      open: boolean,
      details?: { cancel: () => void; allowPropagation: () => void }
    ) => void;
  }) => {
    harness.menuOpen = Boolean(open);
    harness.menuOnOpenChange = onOpenChange;
    return createElement('div', null, children);
  };
  // 仿 base-ui FloatingPortal：打开那次提交只建门户节点，下一次渲染才挂载弹层内容
  const DeferredPortal = ({ children }: WrapperProps) => {
    const [mounted, setMounted] = useState(false);
    useLayoutEffect(() => setMounted(true), []);
    return mounted ? createElement('div', null, children) : null;
  };
  const MenuPopup = ({ children }: WrapperProps) => {
    if (!harness.deferPopup) return createElement('div', null, children);
    return harness.menuOpen ? createElement(DeferredPortal, null, children) : null;
  };
  const MenuItem = ({ children, onClick }: ClickWrapperProps) => {
    if (onClick) harness.menuItemClicks.push(onClick);
    return createElement('div', { onClick }, children);
  };
  const MenuTrigger = ({
    children,
    title,
    className,
  }: WrapperProps & { title?: string; className?: string }) =>
    createElement('button', { type: 'button', title, className }, children);
  return {
    Menu,
    MenuGroup: Wrap,
    MenuGroupLabel: Wrap,
    MenuItem,
    MenuPopup,
    MenuSub: Wrap,
    MenuSubPopup: Wrap,
    MenuSubTrigger: Wrap,
    MenuTrigger,
  };
});

vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: WrapperProps) => createElement('span', null, children),
}));

vi.mock('@/components/ui/button', () => ({
  Button: (props: Record<string, unknown>) => {
    harness.buttons.push(props);
    return createElement(
      'button',
      {
        type: 'button',
        'aria-pressed': props['aria-pressed'],
        'data-reasoning-mode': props['data-reasoning-mode'],
      },
      props.children as ReactNode
    );
  },
}));

vi.mock('@/components/ui/switch', () => ({
  Switch: (props: Record<string, unknown>) => {
    harness.switchProps = props;
    return createElement('i', { 'data-switch': 'true' });
  },
}));

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

const commonProps = {
  providers,
  providerId: 'api',
  modelId: 'model',
  reasoningEnabled: true,
  thinkingLevel: 'medium' as const,
  onSelect: vi.fn(),
  onReasoningChange: vi.fn(),
  onThinkingChange: vi.fn(),
};

beforeEach(() => {
  harness.menuItemClicks = [];
  harness.menuOpen = false;
  harness.deferPopup = false;
  harness.menuOnOpenChange = undefined;
  harness.switchProps = null;
  harness.buttons = [];
  harness.meta = {};
  harness.usageAccountKeys = [];
  harness.usageData = {};
  harness.recentModels = [];
  harness.togglePinnedModel.mockClear();
  harness.recordRecentModel.mockClear();
  harness.removeRecentModel.mockClear();
  harness.providers = [];
  harness.updateProvider.mockClear();
  commonProps.onSelect.mockClear();
  commonProps.onReasoningChange.mockClear();
  commonProps.onThinkingChange.mockClear();
});

describe('ModelPicker reasoning controls mode', () => {
  const triggerTokens = (html: string, marker: string) =>
    (html.match(new RegExp(`<button[^>]*${marker}[^>]*>`))?.[0].match(/class="([^"]*)"/)?.[1] ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .sort();
  const selectTokens = (size: 'sm' | 'default') =>
    triggerTokens(
      renderToStaticMarkup(
        createElement(Select, { value: 'a' }, createElement(SelectTrigger, { size }, 'A'))
      ),
      'data-slot="select-trigger"'
    );

  it('表单触发器与同尺寸 ui 下拉同一套外观：类名一致，右侧是 ⇕ 图标', () => {
    for (const [triggerClassName, size] of [
      [MODEL_PICKER_FORM_TRIGGER_CLASS, 'sm'],
      [MODEL_PICKER_DIALOG_TRIGGER_CLASS, 'default'],
    ] as const) {
      const html = renderToStaticMarkup(
        createElement(ModelPicker, { ...commonProps, triggerClassName })
      );
      expect(triggerTokens(html, 'title=')).toEqual(selectTokens(size));
      expect(html).toContain('lucide-chevrons-up-down');
      expect(html).not.toContain('lucide-chevron-down');
    }
  });

  it('会话工具行的模型芯片仍是 ∨ 图标', () => {
    const html = renderToStaticMarkup(createElement(ModelPicker, commonProps));
    expect(html).toContain('lucide-chevron-down');
    expect(html).not.toContain('lucide-chevrons-up-down');
  });

  it('账号池复用普通账号额度区域并跟随当前会话实际接替账号', () => {
    const pool = {
      ...providers[0],
      oauthAccountKey: 'openai-codex',
      oauthAccountPool: { accountKeys: ['openai-codex', 'openai-codex#2'] },
    };
    const activeAccount = { providerId: 'api', modelId: 'model', accountKey: 'openai-codex#2' };
    harness.usageData = {
      'openai-codex#2': { key: 'openai-codex#2', windows: [{ label: 'Actual', usedPercent: 73 }] },
      'openai-codex': { key: 'openai-codex', windows: [{ label: 'Anchor', usedPercent: 12 }] },
    };
    const firstHtml = renderToStaticMarkup(
      createElement(ModelPicker, { ...commonProps, providers: [pool], ...{ activeAccount } })
    );
    expect(firstHtml).toContain('73%');
    expect(firstHtml).not.toContain('12%');
    expect(harness.usageAccountKeys).toEqual(['openai-codex#2']);
    harness.usageAccountKeys = [];
    const switchedHtml = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        providers: [pool],
        ...{ activeAccount: { ...activeAccount, accountKey: 'openai-codex' } },
      })
    );
    expect(harness.usageAccountKeys).toEqual(['openai-codex']);
    expect(switchedHtml).toContain('12%');
    expect(switchedHtml).not.toContain('73%');
  });
  it.each([
    { providerId: 'other-pool', modelId: 'model', accountKey: 'openai-codex#2' },
    { providerId: 'api', modelId: 'other-model', accountKey: 'openai-codex#2' },
    { providerId: 'api', modelId: 'model', accountKey: 'openai-codex#3' },
  ])('池不展示不同路由或已移除实际成员的额度：%j', (activeAccount) => {
    renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        providers: [
          {
            ...providers[0],
            oauthAccountKey: 'openai-codex',
            oauthAccountPool: { accountKeys: ['openai-codex', 'openai-codex#2'] },
          },
        ],
        activeAccount,
      })
    );
    expect(harness.usageAccountKeys).toEqual([]);
  });
  it('切换自定义子模型保留条目深度，不被目标模型行的上限覆盖', () => {
    const onThinkingNormalize = vi.fn();
    renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        providers: [
          {
            ...providers[0],
            models: [{ id: 'model' }, { id: 'target', thinkingLevel: 'high' }],
          },
        ],
        reasoningMode: 'on',
        thinkingLevel: 'max',
        modelCapabilityOverrides: { reasoning: 'on', thinkingLevel: 'max' },
        onThinkingNormalize,
      })
    );
    harness.menuItemClicks[1]();
    expect(commonProps.onSelect).toHaveBeenCalledWith('api', 'target');
    expect(onThinkingNormalize).not.toHaveBeenCalled();
  });

  it.each(['high', 'max'] as const)(
    '自定义子模型选低档后仍可再选 max，不把当前深度变成上限：%s',
    (rowLevel) => {
      const row = { id: 'model', thinkingLevel: rowLevel };
      const capability = resolvePickerCapabilities(providers[0], row, undefined, {
        reasoning: 'on',
        thinkingLevel: 'low',
      });
      expect(capability.thinkingLevels).toEqual([
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      expect(persistClampedThinkingLevel('max', capability.declaredThinkingLevels)).toBeUndefined();
    }
  );

  it('自定义模型行 off 且条目 off 时仍可点击 On', () => {
    renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        reasoningMode: 'off',
        reasoningEnabled: false,
        providers: [{ ...providers[0], models: [{ id: 'model', reasoning: 'off' }] }],
        modelCapabilityOverrides: { reasoning: 'off' },
      })
    );
    expect(harness.buttons.find((button) => button['data-reasoning-mode'] === 'on')?.disabled).toBe(
      false
    );
  });

  it('子模型当前条目的显式覆盖压过自定义模型行，不被行 off/high 归一化', () => {
    const row = { id: 'model', reasoning: 'off' as const, thinkingLevel: 'high' as const };
    const capability = resolvePickerCapabilities(providers[0], row, undefined, {
      reasoning: 'on',
      thinkingLevel: 'max',
    });
    expect(capability.reasoning).toBe(true);
    expect(capability.thinkingLevels).toContain('max');
    expect(persistClampedThinkingLevel('max', capability.declaredThinkingLevels)).toBeUndefined();
  });

  it('子模型覆盖不能突破 OAuth catalog 支持集', () => {
    const capability = resolvePickerCapabilities(
      { ...providers[0], oauthAccountKey: 'subscription' },
      providers[0].models[0],
      {
        modelId: 'model',
        source: 'catalog',
        reasoning: false,
        thinkingLevels: [],
      },
      { reasoning: 'on', thinkingLevel: 'max' }
    );
    expect(capability.reasoning).toBe(false);
    expect(capability.thinkingLevels).toEqual([]);
  });

  it('条目覆盖用于展示，切换模型也不丢弃已保存的深度', () => {
    const onThinkingNormalize = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        thinkingLevel: 'max',
        modelCapabilityOverrides: { reasoning: 'on', thinkingLevel: 'max' },
        providers: [
          {
            ...providers[0],
            models: [
              { id: 'model', reasoning: 'off', thinkingLevel: 'high' },
              { id: 'other', thinkingLevel: 'low' },
            ],
          },
        ],
        onThinkingNormalize,
      })
    );
    expect(harness.switchProps?.checked).toBe(true);
    const ticks = [...html.matchAll(/data-thinking-tick="([^"]+)"/g)].map((m) => m[1]);
    expect(ticks).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    harness.menuItemClicks[0]?.();
    expect(onThinkingNormalize).not.toHaveBeenCalled();
    harness.menuItemClicks[1]?.();
    expect(onThinkingNormalize).not.toHaveBeenCalled();
  });

  it.each([
    { reasoningMode: 'follow' as const, slider: false },
    { reasoningMode: 'off' as const, slider: false },
    { reasoningMode: 'on' as const, slider: true },
  ])('子模型三态明确选中，只有显式开启才显示独立深度滑杆：%j', ({ slider, ...mode }) => {
    const html = renderToStaticMarkup(createElement(ModelPicker, { ...commonProps, ...mode }));
    expect(
      harness.buttons
        .filter((button) => button['aria-pressed'] === true)
        .map((button) => button['data-reasoning-mode'])
    ).toEqual([mode.reasoningMode]);
    expect(html.includes('data-thinking-levels="true"')).toBe(slider);
    expect(html).not.toContain('data-switch="true"');
    expect(html).not.toContain('Explicit');
    expect(html).not.toContain('global defaults');
  });

  it('三态点击通过单次模式回调携带有效档位，供设置原子落盘', () => {
    const onReasoningModeChange = vi.fn();
    renderToStaticMarkup(
      createElement(ModelPicker, { ...commonProps, reasoningMode: 'off', onReasoningModeChange })
    );
    for (const mode of ['on', 'off', 'follow']) {
      const click = harness.buttons.find(
        (button) => button['data-reasoning-mode'] === mode
      )?.onClick;
      expect(click).toBeTypeOf('function');
      (click as () => void)();
    }
    expect(onReasoningModeChange.mock.calls).toEqual([
      ['on', 'medium'],
      ['off', 'medium'],
      ['follow', 'medium'],
    ]);
    expect(commonProps.onReasoningChange).not.toHaveBeenCalled();
    expect(commonProps.onThinkingChange).not.toHaveBeenCalled();
  });

  it('旧 On 缺深度立即显示可调滑杆，不需要 Customize 且渲染不写入', () => {
    const onReasoningModeChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        reasoningMode: 'on',
        modelCapabilityOverrides: { reasoning: 'on' },
        onReasoningModeChange,
      })
    );
    expect(html).toContain('data-thinking-levels="true"');
    expect(html).not.toContain('Customize');
    expect(harness.buttons.filter((button) => button['data-slot'] === 'follow-depth')).toHaveLength(
      0
    );
    expect(html).toContain('data-thinking-tick="medium" aria-pressed="true"');
    expect(onReasoningModeChange).not.toHaveBeenCalled();
    expect(commonProps.onThinkingChange).not.toHaveBeenCalled();
  });

  it('OAuth 开启时提供支持集内的默认档位用于原子初始化', () => {
    harness.meta = {
      model: {
        modelId: 'model',
        source: 'catalog',
        reasoning: true,
        thinkingLevels: ['low', 'high'],
      },
    };
    const onReasoningModeChange = vi.fn();
    renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        reasoningMode: 'follow',
        providers: [{ ...providers[0], oauthAccountKey: 'subscription' }],
        onReasoningModeChange,
      })
    );
    const on = harness.buttons.find((button) => button['data-reasoning-mode'] === 'on')?.onClick;
    expect(on).toBeTypeOf('function');
    (on as () => void)();
    expect(onReasoningModeChange).toHaveBeenCalledWith('on', 'high');
  });

  it.each<ThinkingLevel[]>([
    ['high'],
    ['low', 'high'],
    ['minimal', 'low', 'medium', 'high'],
    ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  ])('分段胶囊按支持集渲染并高亮当前档位，单档禁用：%j', (...levels) => {
    harness.meta = {
      model: { modelId: 'model', source: 'catalog', reasoning: true, thinkingLevels: levels },
    };
    for (const thinkingLevel of levels) {
      const html = renderToStaticMarkup(
        createElement(ModelPicker, { ...commonProps, thinkingLevel })
      );
      const ticks = [...html.matchAll(/data-thinking-tick="([^"]+)"/g)].map((m) => m[1]);
      expect(ticks).toEqual(levels);
      expect(html).toContain(`data-thinking-tick="${thinkingLevel}" aria-pressed="true"`);
      expect(
        html.includes(`data-thinking-tick="${thinkingLevel}" aria-pressed="true" disabled=""`)
      ).toBe(levels.length === 1);
    }
  });

  it.each([
    undefined,
    { modelId: 'model', source: 'unknown' as const },
    { modelId: 'model', source: 'catalog' as const },
  ])('缺失支持字段不把乐观展示当成已知能力回写：%j', (meta) => {
    const custom = resolvePickerCapabilities(providers[0], providers[0].models[0], meta);
    const oauth = resolvePickerCapabilities(
      { ...providers[0], oauthAccountKey: 'subscription' },
      providers[0].models[0],
      meta
    );
    expect(persistClampedThinkingLevel('max', custom.declaredThinkingLevels)).toBeUndefined();
    expect(persistClampedThinkingLevel('max', oauth.declaredThinkingLevels)).toBeUndefined();
    expect(oauth.reasoning).toBeUndefined();
  });

  it('自定义模型收到只有推理开关和窗口的元数据后仍保留最高档', () => {
    const render = () =>
      renderToStaticMarkup(createElement(ModelPicker, { ...commonProps, thinkingLevel: 'max' }));
    const maxTick = 'data-thinking-tick="max" aria-pressed="true"';
    expect(render()).toContain(maxTick);

    harness.meta = {
      model: {
        modelId: 'model',
        source: 'catalog-fallback',
        reasoning: true,
        contextWindow: 128_000,
      },
    };
    expect(render()).toContain(maxTick);
  });

  it.each<{
    row: Partial<ModelEntry>;
    meta: ModelMeta;
    enabled: boolean;
    max?: number;
    oauth?: boolean;
  }>([
    {
      row: { reasoning: 'off' },
      meta: { modelId: 'model', source: 'catalog', reasoning: true },
      enabled: false,
    },
    {
      row: { reasoning: 'on', thinkingLevel: 'high' },
      meta: { modelId: 'model', source: 'catalog', reasoning: false, thinkingLevels: [] },
      enabled: true,
      max: 3,
    },
    {
      row: { thinkingLevel: 'xhigh' },
      meta: {
        modelId: 'model',
        source: 'catalog-fallback',
        reasoning: true,
        thinkingLevels: ['minimal', 'low'],
      },
      enabled: true,
      max: 4,
    },
    {
      row: { reasoning: 'on', thinkingLevel: 'max' },
      meta: { modelId: 'model', source: 'catalog', reasoning: false, thinkingLevels: [] },
      enabled: false,
      oauth: true,
    },
    {
      row: { reasoning: 'off', thinkingLevel: 'low' },
      meta: {
        modelId: 'model',
        source: 'catalog',
        reasoning: true,
        thinkingLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
      enabled: true,
      max: 5,
      oauth: true,
    },
  ])('自定义能力按行覆盖解析，OAuth 仅信 catalog：%j', ({ row, meta, enabled, max, oauth }) => {
    harness.meta = { model: meta };
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        providers: [
          {
            ...providers[0],
            oauthAccountKey: oauth ? 'subscription' : undefined,
            models: [{ id: 'model', ...row }],
          },
        ],
      })
    );
    expect(harness.switchProps?.checked).toBe(enabled);
    const ticks = [...html.matchAll(/data-thinking-tick="([^"]+)"/g)].map((m) => m[1]);
    expect(max === undefined ? undefined : ticks.length - 1).toBe(max);
  });

  it('选择尚无元数据的自定义模型仍按显式行上限归一化', () => {
    renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        thinkingLevel: 'max',
        providers: [{ ...providers[0], models: [{ id: 'model', thinkingLevel: 'low' }] }],
      })
    );
    harness.menuItemClicks[0]?.();
    expect(commonProps.onThinkingChange).toHaveBeenCalledWith('low');
  });

  it('keeps reasoning and thinking controls by default for ChatView', () => {
    const html = renderToStaticMarkup(createElement(ModelPicker, commonProps));
    expect(html).toContain('Reasoning');
    expect(html).toContain('Med');
    expect(html).toContain('data-thinking-levels="true"');
  });

  it('表单触发器选中后显示「厂商 / 模型」和推理档', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        emptyLabel: 'Select model',
        triggerClassName: 'form-trigger',
      })
    );
    expect(html).toContain('API entry / Chosen model');
    expect(html).toContain('data-trigger-thinking="medium"');
  });

  it.each([undefined, 'form-trigger'])(
    '主模型和子模型的自动池显示模式而非锚点账号身份或额度：%s',
    (triggerClassName) => {
      const html = renderToStaticMarkup(
        createElement(ModelPicker, {
          ...commonProps,
          triggerClassName,
          providers: [
            {
              ...providers[0],
              name: 'anchor@example.test',
              oauthAccountKey: 'openai-codex#2',
              oauthAccountPool: { accountKeys: ['openai-codex', 'openai-codex#2'] },
            },
          ],
        })
      );
      expect(html).toContain('ChatGPT (automatic failover) / Chosen model');
      expect(html).not.toContain('anchor@example.test');
      expect(html).not.toContain('openai-codex#2');
      expect(harness.usageAccountKeys).toEqual([]);
    }
  );

  it.each([
    { pool: false, triggerClassName: undefined, routedModelLabel: undefined },
    { pool: false, triggerClassName: 'form-trigger', routedModelLabel: undefined },
    { pool: true, triggerClassName: undefined, routedModelLabel: undefined },
    { pool: true, triggerClassName: 'form-trigger', routedModelLabel: undefined },
    { pool: false, triggerClassName: undefined, routedModelLabel: 'Routed model' },
    { pool: false, triggerClassName: 'form-trigger', routedModelLabel: 'Routed model' },
    { pool: true, triggerClassName: undefined, routedModelLabel: 'Routed model' },
    { pool: true, triggerClassName: 'form-trigger', routedModelLabel: 'Routed model' },
  ])('虚拟模型触发器保留虚拟名称与路由标签，不加主模型或账号池前缀：%j', ({ pool, ...props }) => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        ...props,
        providers: [
          {
            ...providers[0],
            ...(pool && {
              oauthAccountKey: 'openai-codex',
              oauthAccountPool: { accountKeys: ['openai-codex', 'openai-codex#2'] },
            }),
          },
        ],
        providerId: VIRTUAL_PROVIDER_ID,
        modelId: 'auto',
        virtualModels: [
          {
            id: 'auto',
            name: 'Auto model',
            enabled: true,
            primary: { providerId: 'api', modelId: 'model' },
            fallbacks: [],
          },
        ],
      })
    );
    const label = props.routedModelLabel ? `Auto model · ${props.routedModelLabel}` : 'Auto model';
    expect(html.match(/<button[^>]*title="([^"]*)"/)?.[1]).toBe(label);
    if (pool) expect(harness.usageAccountKeys).toEqual([]);
  });

  it('虚拟模型以账号池主模型的 catalog 展示能力，选择仍返回虚拟引用', () => {
    harness.meta = {
      model: {
        modelId: 'model',
        source: 'catalog',
        reasoning: true,
        thinkingLevels: ['low', 'high'],
      },
    };
    const virtual: VirtualModelEntry = {
      id: 'auto',
      name: 'Auto model',
      enabled: true,
      primary: { providerId: 'api', modelId: 'model' },
      fallbacks: [],
    };
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        providers: [
          {
            ...providers[0],
            oauthAccountKey: 'openai-codex',
            oauthAccountPool: { accountKeys: ['openai-codex', 'openai-codex#2'] },
          },
        ],
        providerId: VIRTUAL_PROVIDER_ID,
        modelId: virtual.id,
        virtualModels: [virtual],
        thinkingLevel: 'max',
      })
    );
    expect(harness.switchProps?.checked).toBe(true);
    const ticks = [...html.matchAll(/data-thinking-tick="([^"]+)"/g)].map((m) => m[1]);
    expect(ticks).toEqual(['low', 'high']);
    expect(html).toContain('data-thinking-tick="high" aria-pressed="true"');
    harness.menuItemClicks[0]();
    expect(commonProps.onSelect).toHaveBeenCalledWith(VIRTUAL_PROVIDER_ID, virtual.id);
    expect(harness.usageAccountKeys).toEqual([]);
  });

  it('固定账号菜单仍使用本账号额度', () => {
    renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        providers: [{ ...providers[0], oauthAccountKey: 'openai-codex#2' }],
      })
    );
    expect(harness.usageAccountKeys).toContain('openai-codex#2');
  });

  it('跟随默认时表单触发器不显示推理档', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        providerId: '',
        modelId: '',
        emptyLabel: 'Follows the global default',
        triggerClassName: 'form-trigger',
      })
    );
    expect(html).toContain('Follows the global default');
    expect(html).not.toContain('data-trigger-thinking');
  });

  it('已选模型没有 label 时仍显示 id，不被 emptyLabel 盖掉', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        providers: [{ ...providers[0], models: [{ id: 'model' }] }],
        emptyLabel: 'Select model',
      })
    );
    expect(html).toContain('model');
    expect(html).not.toContain('Select model');
  });

  it('hides session-only reasoning and thinking controls for default model settings', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, { ...commonProps, showReasoningControls: false })
    );
    expect(html).toContain('Chosen model');
    expect(html).not.toContain('Reasoning');
    expect(html).not.toContain('data-thinking-levels="true"');
    expect(html).not.toContain('data-switch="true"');
  });

  it('未知支持集不回写思考档；用户操作仍走 change 回调', () => {
    const onThinkingChange = vi.fn();
    renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        thinkingLevel: 'max',
        onThinkingChange,
      })
    );
    harness.menuItemClicks[0]?.();
    expect(onThinkingChange).not.toHaveBeenCalled();

    harness.menuItemClicks = [];
    harness.switchProps = null;
    const onReasoningChange = vi.fn();
    const onReasoningNormalize = vi.fn();
    const onThinkingNormalize = vi.fn();
    renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        thinkingLevel: 'max',
        onReasoningChange,
        onThinkingChange,
        onReasoningNormalize,
        onThinkingNormalize,
      })
    );
    harness.menuItemClicks[0]?.();
    expect(onThinkingNormalize).not.toHaveBeenCalled();
    expect(onThinkingChange).not.toHaveBeenCalled();

    const switchProps = harness.switchProps as Record<string, unknown> | null;
    const onCheckedChange = switchProps?.onCheckedChange;
    if (typeof onCheckedChange === 'function') onCheckedChange(false);
    expect(onReasoningChange).toHaveBeenCalledWith(false);
    expect(onReasoningNormalize).not.toHaveBeenCalled();
  });

  it('catalog 显式支持集才回写钳位档', () => {
    expect(persistClampedThinkingLevel('max', undefined)).toBeUndefined();
    expect(persistClampedThinkingLevel('max', ['low', 'high'])).toBe('high');
    expect(persistClampedThinkingLevel('high', ['low', 'high'])).toBeUndefined();
  });

  it('只渲染当前模型声明支持的思考档，normalize no-op 时仍显示钳位值', () => {
    harness.meta = {
      model: {
        modelId: 'model',
        source: 'catalog',
        reasoning: true,
        thinkingLevels: ['low', 'high'],
      },
    };
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        thinkingLevel: 'max',
        onThinkingNormalize: () => undefined,
      })
    );
    expect(html).toContain('>Low<');
    expect(html).toContain('>High<');
    expect(html).not.toContain('>Min<');
    expect(html).not.toContain('>Med<');
    expect(html).not.toContain('>Extra<');
    expect(html).not.toContain('>Max<');
  });

  it('模型不支持推理时 normalize no-op 也显示为关闭且隐藏滑杆', () => {
    harness.meta = {
      model: {
        modelId: 'model',
        source: 'catalog',
        reasoning: false,
        thinkingLevels: [],
      },
    };
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        onReasoningNormalize: () => undefined,
      })
    );
    const switchProps = harness.switchProps as Record<string, unknown> | null;
    expect(switchProps?.checked).toBe(false);
    expect(html).not.toContain('data-thinking-levels="true"');
    expect(html).not.toContain('>Med<');
  });
});

describe('duplicateModelLabels', () => {
  it('同一条目内重名的已启用模型需要附 id 消歧', () => {
    const models: ModelEntry[] = [
      { id: 'cursor-grok-4.6', label: 'Grok 4.6 Medium' },
      { id: 'grok-4.6', label: 'Grok 4.6 Medium' },
      { id: 'grok-4.6-max', label: 'Grok 4.6 Max Medium' },
      { id: 'x', label: 'Grok 4.6 Max Medium', enabled: false },
      { id: 'no-label' },
      { id: 'other', label: 'no-label' },
    ];
    expect([...duplicateModelLabels(models)]).toEqual(['Grok 4.6 Medium', 'no-label']);
  });

  it('重名模型的 id 单独成行，不重名的不附 id', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        providers: [
          {
            ...providers[0],
            models: [
              { id: 'cursor-grok-4.6', label: 'Grok 4.6 Medium' },
              { id: 'grok-4.6', label: 'Grok 4.6 Medium' },
              { id: 'gpt-5', label: 'GPT-5' },
            ],
          },
        ],
      })
    );
    expect(html).toContain('data-model-row-id="cursor-grok-4.6"');
    expect(html).toContain('data-model-row-id="grok-4.6"');
    expect(html).not.toContain('data-model-row-id="gpt-5"');
    expect(html).toContain('title="Grok 4.6 Medium"');
    expect(html).toContain('title="cursor-grok-4.6"');
    expect(html).toContain('title="grok-4.6"');
    expect(html).toContain('title="GPT-5"');
  });
});

describe('模型行收缩优先级', () => {
  const xaiSource = 'xAI (Grok/X subscription) · grok@j3.do';
  const rowProviders: ModelProvider[] = [
    {
      ...providers[0],
      id: 'xai',
      name: xaiSource,
      models: [
        { id: 'grok-4.7-build-fast', contextWindow: 500_000 },
        { id: 'claude-opus-5-5', contextWindow: 1_000_000 },
      ],
    },
  ];
  const rowOf = (html: string, modelId: string) => {
    const start = html.indexOf(`data-model-pin="${pinnedModelKey('xai', modelId)}"`);
    const next = html.indexOf('data-model-pin=', start + 1);
    return html.slice(start, next === -1 ? undefined : next);
  };
  const classOf = (row: string, attr: string) =>
    row.match(new RegExp(`<span ${attr}="[^"]*"[^>]*class="([^"]*)"`))?.[1]?.split(' ') ?? [];

  it('星标行：长来源小字先收缩，模型名不让位，上下文长度不收缩，名字悬停显示全名', () => {
    harness.pinnedModels = [
      pinnedModelKey('xai', 'grok-4.7-build-fast'),
      pinnedModelKey('xai', 'claude-opus-5-5'),
    ];
    try {
      // 当前选中不在任何分组里时右栏落在「星标与虚拟」
      const html = renderToStaticMarkup(
        createElement(ModelPicker, {
          ...commonProps,
          providers: rowProviders,
          providerId: 'gone',
          modelId: 'gone',
          virtualModels: [],
        })
      );
      for (const [modelId, context] of [
        ['grok-4.7-build-fast', '500K'],
        ['claude-opus-5-5', '1M'],
      ]) {
        const row = rowOf(html, modelId);
        expect(row).toContain(`title="${modelId}"`);
        expect(row).toContain(`title="Custom · ${xaiSource}"`);
        expect(row).toContain(`>${context}<`);
        const name = classOf(row, 'data-model-row-name');
        const source = classOf(row, 'data-model-row-source');
        // 名字按自身宽度排、最后才截断；小字 basis 0 先让空间、从账号一端截断
        expect(name).toEqual(expect.arrayContaining(['min-w-0', 'truncate', 'flex-initial']));
        expect(name).not.toContain('flex-1');
        expect(source).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'truncate']));
        expect(source).not.toContain('shrink-0');
        expect(classOf(row, 'data-model-row-context')).toContain('shrink-0');
        expect(row.indexOf('data-model-row-name')).toBeLessThan(
          row.indexOf('data-model-row-source')
        );
        expect(row.indexOf('data-model-row-source')).toBeLessThan(
          row.indexOf('data-model-row-context')
        );
      }
    } finally {
      harness.pinnedModels = [];
    }
  });

  it('分组行无来源小字时模型名占满剩余宽度，✓ 不收缩', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        providers: rowProviders,
        providerId: 'xai',
        modelId: 'claude-opus-5-5',
        virtualModels: [],
      })
    );
    const row = rowOf(html, 'grok-4.7-build-fast');
    expect(classOf(row, 'data-model-row-name')).toContain('flex-1');
    expect(row).not.toContain('data-model-row-source');
    const selected = rowOf(html, 'claude-opus-5-5');
    expect(selected).toContain('title="claude-opus-5-5"');
    expect(classOf(selected, 'data-model-row-context')).toContain('shrink-0');
    expect(selected).toMatch(/<svg[^>]*class="[^"]*lucide-check[^"]*shrink-0/);
  });
});

function pickerProvider(id: string, name: string): ModelProvider {
  return {
    ...providers[0],
    id,
    name,
    models: [{ id: 'm', label: name }],
  };
}

describe('resolveActiveWorkbenchView', () => {
  const work = pickerProvider('work', 'Work');
  const personal = pickerProvider('personal', 'Personal');
  const gateway = pickerProvider('gateway', 'Gateway');
  const openai: ProviderGroup = {
    vendorId: 'openai',
    label: 'OpenAI',
    providers: [work, personal],
  };
  const custom: ProviderGroup = {
    vendorId: 'custom',
    label: 'Custom',
    providers: [gateway],
  };
  const groups = [openai, custom];
  const virtual: VirtualModelEntry = {
    id: 'auto',
    name: 'Auto route',
    enabled: true,
    primary: { providerId: 'work', modelId: 'm' },
    fallbacks: [],
  };

  it('未指定导航时落到当前供应商所在厂商，并选中该账号', () => {
    const view = resolveActiveWorkbenchView({
      groups,
      selectableVirtualModels: [],
      pinnedCount: 0,
      selectedProviderId: 'personal',
      activeNav: null,
    });
    expect(view.showFavoritesNav).toBe(false);
    expect(view.activeNav).toEqual({ kind: 'vendor', vendorId: 'openai' });
    expect(view.activeGroup).toBe(openai);
    expect(view.activeProvider).toBe(personal);
  });

  it('当前选中虚拟模型时默认打开常用栏', () => {
    const view = resolveActiveWorkbenchView({
      groups,
      selectableVirtualModels: [virtual],
      pinnedCount: 0,
      selectedProviderId: VIRTUAL_PROVIDER_ID,
      activeNav: null,
    });
    expect(view.showFavoritesNav).toBe(true);
    expect(view.activeNav).toEqual({ kind: 'favorites' });
    expect(view.activeGroup).toBeUndefined();
    expect(view.activeProvider).toBeUndefined();
  });

  it('同厂商多账号优先用右栏记住的账号，否则用当前选中，再否则用第一个', () => {
    const remembered = resolveActiveWorkbenchView({
      groups,
      selectableVirtualModels: [],
      pinnedCount: 0,
      selectedProviderId: 'work',
      activeNav: { kind: 'vendor', vendorId: 'openai' },
      activeProviderByVendor: { openai: 'personal' },
    });
    expect(remembered.activeProvider).toBe(personal);

    const selected = resolveActiveWorkbenchView({
      groups,
      selectableVirtualModels: [],
      pinnedCount: 0,
      selectedProviderId: 'work',
      activeNav: { kind: 'vendor', vendorId: 'openai' },
      activeProviderByVendor: { openai: 'missing' },
    });
    expect(selected.activeProvider).toBe(work);

    const first = resolveActiveWorkbenchView({
      groups,
      selectableVirtualModels: [],
      pinnedCount: 1,
      selectedProviderId: 'gateway',
      activeNav: { kind: 'vendor', vendorId: 'openai' },
    });
    expect(first.activeProvider).toBe(work);
    expect(first.showFavoritesNav).toBe(true);
  });

  it('单账号厂商直接定位到该账号；失效导航退回当前选中或第一项', () => {
    const single = resolveActiveWorkbenchView({
      groups,
      selectableVirtualModels: [],
      pinnedCount: 0,
      selectedProviderId: 'gateway',
      activeNav: null,
    });
    expect(single.activeNav).toEqual({ kind: 'vendor', vendorId: 'custom' });
    expect(single.activeProvider).toBe(gateway);
    expect(single.activeGroup?.providers).toHaveLength(1);

    const staleFavorites = resolveActiveWorkbenchView({
      groups,
      selectableVirtualModels: [],
      pinnedCount: 0,
      selectedProviderId: 'gateway',
      activeNav: { kind: 'favorites' },
    });
    expect(staleFavorites.activeNav).toEqual({ kind: 'vendor', vendorId: 'custom' });

    const staleVendor = resolveActiveWorkbenchView({
      groups,
      selectableVirtualModels: [virtual],
      pinnedCount: 0,
      selectedProviderId: 'missing',
      activeNav: { kind: 'vendor', vendorId: 'gone' },
    });
    expect(staleVendor.activeNav).toEqual({ kind: 'favorites' });

    const firstGroup = resolveActiveWorkbenchView({
      groups,
      selectableVirtualModels: [],
      pinnedCount: 0,
      selectedProviderId: VIRTUAL_PROVIDER_ID,
      activeNav: null,
    });
    expect(firstGroup.activeNav).toEqual({ kind: 'vendor', vendorId: 'openai' });
    expect(firstGroup.activeProvider).toBe(work);
  });
});

describe('model picker workbench', () => {
  const workbenchProviders: ModelProvider[] = [
    {
      ...providers[0],
      id: 'work',
      name: 'Work',
      oauthAccountKey: 'openai',
      models: [{ id: 'gpt', label: 'GPT Work' }],
    },
    {
      ...providers[0],
      id: 'personal',
      name: 'Personal',
      oauthAccountKey: 'openai#2',
      models: [{ id: 'gpt', label: 'GPT Personal' }],
    },
    {
      ...providers[0],
      id: 'gateway',
      name: 'Gateway',
      models: [{ id: 'gw', label: 'Gateway model' }],
    },
    {
      ...providers[0],
      id: 'relay',
      name: 'Relay',
      baseUrl: 'https://relay.example.test/v1',
      models: [{ id: 'rl', label: 'Relay model' }],
    },
  ];

  it('自定义供应商在左栏逐个平铺，不折叠进单个自定义组', () => {
    const expanded = expandWorkbenchGroups([
      {
        vendorId: 'openai',
        label: 'OpenAI',
        providers: [workbenchProviders[0], workbenchProviders[1]],
      },
      {
        vendorId: '__custom',
        label: '',
        providers: [workbenchProviders[2], workbenchProviders[3]],
      },
    ]);
    expect(expanded.map((group) => ({ vendorId: group.vendorId, label: group.label }))).toEqual([
      { vendorId: 'openai', label: 'OpenAI' },
      { vendorId: '__custom:gateway', label: 'Gateway' },
      { vendorId: '__custom:relay', label: 'Relay' },
    ]);
  });

  it('左栏列出全部厂商，多账号只在右栏切换且只查当前账号额度', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        providers: workbenchProviders,
        providerId: 'work',
        modelId: 'gpt',
        virtualModels: [
          {
            id: 'auto',
            name: 'Auto route',
            enabled: true,
            primary: { providerId: 'work', modelId: 'gpt' },
            fallbacks: [],
          },
        ],
      })
    );
    expect(html).toContain('data-model-picker="workbench"');
    expect(html).toContain('data-model-picker-nav="favorites"');
    expect(html).toContain('Starred &amp; virtual');
    expect(html).toContain('data-model-picker-vendor="openai"');
    expect(html).toContain('data-model-picker-vendor="__custom:gateway"');
    expect(html).toContain('data-model-picker-vendor="__custom:relay"');
    expect(html).not.toContain('data-model-picker-vendor="__custom"');
    expect(html).toContain('Gateway');
    expect(html).toContain('Relay');
    expect(html).toContain('2 accounts');
    expect(html).toContain('data-model-picker="account-tabs"');
    expect(html).toContain('data-model-picker-account="work"');
    expect(html).toContain('data-model-picker-account="personal"');
    expect(html).not.toContain('data-model-picker-account="gateway"');
    expect(html).toContain('GPT Work');
    expect(html).not.toContain('GPT Personal');
    expect(html).not.toContain('Auto route');
    expect(html).toContain(`data-model-pin="${pinnedModelKey('work', 'gpt')}"`);
    const workbenchHtml = html.slice(html.indexOf('data-model-picker="workbench"'));
    expect(workbenchHtml.indexOf(`data-model-pin="${pinnedModelKey('work', 'gpt')}"`)).toBeLessThan(
      workbenchHtml.indexOf('GPT Work')
    );
    expect(harness.usageAccountKeys).toEqual(['openai']);
  });

  it('星标取自 settings，桌面与 PWA 完整模式共享', () => {
    const render = () =>
      renderToStaticMarkup(
        createElement(ModelPicker, {
          ...commonProps,
          providers: workbenchProviders,
          providerId: 'work',
          modelId: 'gpt',
          virtualModels: [],
        })
      );
    harness.pinnedModels = [];
    expect(render()).not.toContain('data-model-picker-nav="favorites"');
    harness.pinnedModels = [pinnedModelKey('work', 'gpt')];
    try {
      expect(render()).toContain('data-model-picker-nav="favorites"');
    } finally {
      harness.pinnedModels = [];
    }
  });

  it('单账号厂商把账号名放在左栏，右栏用账号头而不是切换胶囊', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        providers: workbenchProviders,
        providerId: 'gateway',
        modelId: 'gw',
      })
    );
    expect(html).toContain('data-model-picker-vendor="__custom:gateway"');
    expect(html).toContain('data-model-picker-vendor="__custom:relay"');
    expect(html).toContain('Gateway');
    expect(html).toContain('data-model-picker="account-header"');
    expect(html).toContain('example.test');
    expect(html).not.toContain('data-model-picker="account-tabs"');
    expect(html).toContain('Gateway model');
    expect(harness.usageAccountKeys).toEqual([]);
  });
});

describe('centeredScrollTop', () => {
  const list = { clientHeight: 100, scrollHeight: 600 };

  it('把目标项放到可视区中间', () => {
    expect(centeredScrollTop(list, { offsetTop: 300, offsetHeight: 30 })).toBe(265);
  });

  it('靠近顶部或底部时夹在可滚范围内', () => {
    expect(centeredScrollTop(list, { offsetTop: 10, offsetHeight: 30 })).toBe(0);
    expect(centeredScrollTop(list, { offsetTop: 580, offsetHeight: 20 })).toBe(500);
    expect(
      centeredScrollTop(
        { clientHeight: 100, scrollHeight: 80 },
        { offsetTop: 40, offsetHeight: 20 }
      )
    ).toBe(0);
  });
});

describe('model picker 打开时滚到当前渠道', () => {
  const vendorProviders: ModelProvider[] = [
    {
      ...providers[0],
      id: 'work',
      name: 'Work',
      oauthAccountKey: 'openai',
      models: [{ id: 'gpt', label: 'GPT Work' }],
    },
    {
      ...providers[0],
      id: 'gateway',
      name: 'Gateway',
      models: [{ id: 'gw', label: 'Gateway model' }],
    },
    {
      ...providers[0],
      id: 'relay',
      name: 'Relay',
      baseUrl: 'https://relay.example.test/v1',
      models: [{ id: 'rl', label: 'Relay model' }],
    },
  ];

  const ROW = 30;
  const LIST_HEIGHT = 40;
  const openDetails = { cancel() {}, allowPropagation() {} };
  const layoutProps = ['scrollTop', 'clientHeight', 'scrollHeight', 'offsetTop', 'offsetHeight'];
  let scrollWrites: Array<{ el: HTMLElement; value: number }>;
  let proto: object;
  let doc: Document;
  let root: Root;

  async function mount(props: Partial<Parameters<typeof ModelPicker>[0]>) {
    await act(async () => {
      root.render(
        createElement(ModelPicker, { ...commonProps, providers: vendorProviders, ...props })
      );
    });
  }

  async function setOpen(next: boolean) {
    await act(async () => {
      harness.menuOnOpenChange?.(next, openDetails);
    });
  }

  const navList = () => doc.querySelector('[data-model-picker="nav-list"]') as HTMLElement | null;
  const navItem = (vendor: string) =>
    doc.querySelector(`[data-model-picker-vendor="${vendor}"]`) as HTMLElement;

  beforeEach(() => {
    harness.deferPopup = true;
    scrollWrites = [];
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    Object.assign(dom.window, {
      electronAPI: { providers: { listOauth: () => Promise.resolve([]) } },
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    doc = dom.document as unknown as Document;
    // linkedom 不做布局：每个导航项高 ROW，按兄弟序号排；渠道列表可视高 LIST_HEIGHT
    proto = dom.window.HTMLElement.prototype;
    const scrollTops = new WeakMap<object, number>();
    Object.defineProperties(proto, {
      scrollTop: {
        configurable: true,
        get(this: HTMLElement) {
          return scrollTops.get(this) ?? 0;
        },
        set(this: HTMLElement, value: number) {
          scrollTops.set(this, value);
          scrollWrites.push({ el: this, value });
        },
      },
      clientHeight: { configurable: true, get: () => LIST_HEIGHT },
      scrollHeight: {
        configurable: true,
        get(this: HTMLElement) {
          return this.children.length * ROW + 12;
        },
      },
      offsetHeight: { configurable: true, get: () => ROW },
      offsetTop: {
        configurable: true,
        get(this: HTMLElement) {
          return 6 + Array.from(this.parentElement?.children ?? []).indexOf(this) * ROW;
        },
      },
    });
    root = createRoot(dom.document.getElementById('root') as unknown as HTMLElement);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    for (const key of layoutProps) delete (proto as Record<string, unknown>)[key];
    vi.unstubAllGlobals();
  });

  it('弹层内容延后挂载时，打开后仍把当前渠道滚到中间', async () => {
    await mount({ providerId: 'relay', modelId: 'rl' });
    expect(navList()).toBeNull();
    await setOpen(true);
    const list = navList();
    expect(list).not.toBeNull();
    const target = navItem('__custom:relay');
    expect(target.offsetTop).toBeGreaterThan(LIST_HEIGHT);
    expect(scrollWrites).toEqual([
      { el: list, value: centeredScrollTop(list as HTMLElement, target) },
    ]);
    expect(list?.scrollTop).toBeGreaterThan(0);
  });

  it('没有选中项时不滚动', async () => {
    await mount({ providerId: '', modelId: '' });
    await setOpen(true);
    expect(navList()).not.toBeNull();
    expect(scrollWrites).toEqual([]);
  });

  it('用户滚动后，重渲染与列表重挂载都不再拽回', async () => {
    await mount({ providerId: 'relay', modelId: 'rl' });
    await setOpen(true);
    expect(scrollWrites).toHaveLength(1);
    const list = navList() as HTMLElement;
    list.scrollTop = 0;
    scrollWrites = [];
    await mount({ providerId: 'gateway', modelId: 'gw' });
    await mount({ providers: [], providerId: 'relay', modelId: 'rl' });
    expect(navList()).toBeNull();
    await mount({ providerId: 'relay', modelId: 'rl' });
    expect(navList()).not.toBeNull();
    expect(scrollWrites).toEqual([]);
  });

  it('关闭再打开时重新滚到新的当前渠道', async () => {
    await mount({ providerId: 'relay', modelId: 'rl' });
    await setOpen(true);
    await setOpen(false);
    expect(navList()).toBeNull();
    scrollWrites = [];
    await mount({ providerId: 'gateway', modelId: 'gw' });
    await setOpen(true);
    const list = navList() as HTMLElement;
    const target = navItem('__custom:gateway');
    expect(scrollWrites).toEqual([{ el: list, value: centeredScrollTop(list, target) }]);
  });
});

describe('ModelPicker 窄屏 compact 触发器', () => {
  const auto: VirtualModelEntry = {
    id: 'auto',
    name: 'Auto',
    enabled: true,
    primary: { providerId: 'api', modelId: 'model' },
    fallbacks: [],
  };
  const doc = (html: string) =>
    parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
  const trigger = (html: string) => doc(html).querySelector('button[title]') as HTMLElement;
  const label = (html: string) =>
    doc(html).querySelector('[data-model-picker-label]')?.textContent ?? null;

  it('虚拟模型窄屏只显示虚拟名，成员名留在 title 与弹层当前项里', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        compact: true,
        providerId: VIRTUAL_PROVIDER_ID,
        modelId: 'auto',
        virtualModels: [auto],
        routedModelLabel: 'claude-opus-5-5',
      })
    );
    expect(label(html)).toBe('Auto');
    expect(trigger(html).getAttribute('title')).toBe('Auto · claude-opus-5-5');
    expect(doc(html).querySelector('[data-model-picker-routed]')?.textContent).toBe(
      'claude-opus-5-5'
    );
  });

  it('桌面（非 compact）仍显示「虚拟名 · 成员名」，弹层不额外列成员', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        providerId: VIRTUAL_PROVIDER_ID,
        modelId: 'auto',
        virtualModels: [auto],
        routedModelLabel: 'claude-opus-5-5',
      })
    );
    expect(label(html)).toBe('Auto · claude-opus-5-5');
    expect(doc(html).querySelector('[data-model-picker-routed]')).toBeNull();
    expect(trigger(html).className).toContain('max-w-64');
    expect(doc(html).body.firstElementChild?.className ?? '').not.toContain('max-w-[10rem]');
  });

  it('单个长模型名窄屏限宽单行截断，推理档位与箭头不参与截断', () => {
    const long = 'claude-opus-4-1-20250805-thinking-extended-preview';
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        compact: true,
        providers: [{ ...providers[0], models: [{ id: 'model', label: long }] }],
      })
    );
    const button = trigger(html);
    expect(button.getAttribute('title')).toBe(long);
    expect(doc(html).body.firstElementChild?.className).toContain('max-w-[10rem]');
    // 可收缩但有下限：档位与箭头始终留在芯片内
    expect(doc(html).body.firstElementChild?.className).toContain('min-w-[4.5rem]');
    expect(button.className).not.toContain('max-w-64');
    const span = doc(html).querySelector('[data-model-picker-label]') as HTMLElement;
    expect(span.textContent).toBe(long);
    expect(span.className).toContain('truncate');
    expect(span.className).toContain('min-w-0');
    const thinking = doc(html).querySelector('[data-trigger-thinking]') as HTMLElement;
    expect(thinking.className).toContain('shrink-0');
    expect(thinking.textContent).toBe('Med');
  });

  it('账号池模型窄屏去掉渠道前缀，完整名留在 title', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        compact: true,
        providers: [
          {
            ...providers[0],
            name: 'ChatGPT (automatic failover)',
            oauthAccountKey: 'openai-codex',
            oauthAccountPool: { accountKeys: ['openai-codex', 'openai-codex#2'] },
          },
        ],
      })
    );
    expect(label(html)).toBe('Chosen model');
    expect(trigger(html).getAttribute('title')).toContain('/ Chosen model');
  });

  it('短模型名、无推理档位时 compact 正常显示且不渲染档位', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        ...commonProps,
        compact: true,
        reasoningEnabled: false,
        providers: [{ ...providers[0], models: [{ id: 'model', label: 'deepseek-v4.1-flash' }] }],
      })
    );
    expect(label(html)).toBe('deepseek-v4.1-flash');
    expect(doc(html).querySelector('[data-trigger-thinking]')).toBeNull();
    expect(doc(html).body.firstElementChild?.className).toContain('min-w-[2.75rem]');
  });
});

describe('最近使用分组', () => {
  const recentProviders: ModelProvider[] = [
    {
      ...providers[0],
      id: 'gateway',
      name: 'Gateway',
      models: [
        { id: 'gw', label: 'Gateway model' },
        { id: 'off', label: 'Disabled model', enabled: false },
      ],
    },
    {
      ...providers[0],
      id: 'relay',
      name: 'Relay',
      baseUrl: 'https://relay.example.test/v1',
      models: [{ id: 'rl', label: 'Relay model' }],
    },
  ];
  const auto: VirtualModelEntry = {
    id: 'auto',
    name: 'Auto route',
    enabled: true,
    primary: { providerId: 'gateway', modelId: 'gw' },
    fallbacks: [],
  };
  const ref = (providerId: string, modelId: string): ModelRef => ({ providerId, modelId });
  const openDetails = { cancel() {}, allowPropagation() {} };
  let doc: Document;
  let root: Root;

  async function mount(props: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
    await act(async () => {
      root.render(
        createElement(ModelPicker, {
          ...commonProps,
          providers: recentProviders,
          providerId: 'gateway',
          modelId: 'gw',
          virtualModels: [auto],
          ...props,
        })
      );
    });
  }

  const q = (selector: string) => doc.querySelector(selector) as HTMLElement | null;
  const active = (selector: string) =>
    (q(selector)?.className.split(/\s+/) ?? []).includes('bg-accent');
  const recentRemoveKeys = () =>
    Array.from(doc.querySelectorAll('[data-model-recent-remove]')).map((el) =>
      el.getAttribute('data-model-recent-remove')
    );

  beforeEach(() => {
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    Object.assign(dom.window, {
      electronAPI: { providers: { listOauth: () => Promise.resolve([]) } },
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    doc = dom.document as unknown as Document;
    root = createRoot(dom.document.getElementById('root') as unknown as HTMLElement);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    harness.pinnedModels = [];
    vi.unstubAllGlobals();
  });

  it('会话选择器选中模型时记录到最近使用；未开启记录的选择器不记录', () => {
    renderToStaticMarkup(createElement(ModelPicker, { ...commonProps, recordRecent: true }));
    harness.menuItemClicks[0]();
    expect(harness.recordRecentModel).toHaveBeenCalledWith({ providerId: 'api', modelId: 'model' });

    harness.recordRecentModel.mockClear();
    harness.menuItemClicks = [];
    renderToStaticMarkup(createElement(ModelPicker, commonProps));
    harness.menuItemClicks[0]();
    expect(commonProps.onSelect).toHaveBeenCalledTimes(2);
    expect(harness.recordRecentModel).not.toHaveBeenCalled();
  });

  it('最近使用为空或全部失效时整组不显示', () => {
    const render = () =>
      renderToStaticMarkup(
        createElement(ModelPicker, {
          ...commonProps,
          providers: recentProviders,
          providerId: 'gateway',
          modelId: 'gw',
        })
      );
    harness.recentModels = [];
    expect(render()).not.toContain('data-model-picker-nav="recent"');
    expect(render()).not.toContain('Recently used');
    harness.recentModels = [ref('deleted', 'gw'), ref('gateway', 'off'), ref('gateway', 'gone')];
    expect(render()).not.toContain('data-model-picker-nav="recent"');
    harness.recentModels = [ref('relay', 'rl')];
    expect(render()).toContain('data-model-picker-nav="recent"');
  });

  it('分组排在「星标与虚拟」之后；点击切到右侧最近列表，失效条目被跳过', async () => {
    harness.recentModels = [
      ref('relay', 'rl'),
      ref('deleted', 'gw'),
      ref('gateway', 'off'),
      ref(VIRTUAL_PROVIDER_ID, 'auto'),
      ref(VIRTUAL_PROVIDER_ID, 'gone'),
      ref('gateway', 'gw'),
    ];
    await mount();
    await act(async () => harness.menuOnOpenChange?.(true, openDetails));
    const nav = q('[data-model-picker="nav-list"]') as HTMLElement;
    const order = Array.from(nav.children).map((el) => el.getAttribute('data-model-picker-nav'));
    expect(order.slice(0, 2)).toEqual(['favorites', 'recent']);
    const recentNav = q('[data-model-picker-nav="recent"]') as HTMLElement;
    expect(recentNav.textContent).toContain('Recently used');
    expect(recentNav.textContent).toContain('3');
    expect(active('[data-model-picker-nav="recent"]')).toBe(false);
    expect(active('[data-model-picker-vendor="__custom:gateway"]')).toBe(true);
    expect(q('[data-model-picker="recent-list"]')).toBeNull();

    await act(async () => recentNav.click());
    expect(active('[data-model-picker-nav="recent"]')).toBe(true);
    expect(active('[data-model-picker-vendor="__custom:gateway"]')).toBe(false);
    const list = q('[data-model-picker="recent-list"]') as HTMLElement;
    expect(list.textContent).toContain('Relay model');
    expect(list.textContent).toContain('Auto route');
    expect(list.textContent).toContain('Gateway model');
    expect(list.textContent).not.toContain('Disabled model');
    expect(recentRemoveKeys()).toEqual([
      pinnedModelKey('relay', 'rl'),
      pinnedModelKey(VIRTUAL_PROVIDER_ID, 'auto'),
      pinnedModelKey('gateway', 'gw'),
    ]);

    const relayRow = q(
      `[data-model-recent-remove="${pinnedModelKey('relay', 'rl')}"]`
    )?.parentElement;
    await act(async () => relayRow?.click());
    expect(commonProps.onSelect).toHaveBeenCalledWith('relay', 'rl');
  });

  it('用过 12 个不同模型：分组只列最近的 10 个，按最近使用排序，原有分组仍在', async () => {
    const many: ModelProvider = {
      ...providers[0],
      id: 'many',
      name: 'Many',
      baseUrl: 'https://many.example.test/v1',
      models: Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, label: `Model ${i + 1}` })),
    };
    let recent: ModelRef[] = [];
    for (const model of many.models) recent = pushRecentModel(recent, ref('many', model.id));
    harness.recentModels = recent;
    await mount({ providers: [...recentProviders, many] });
    await act(async () => harness.menuOnOpenChange?.(true, openDetails));
    const nav = q('[data-model-picker="nav-list"]') as HTMLElement;
    const order = Array.from(nav.children).map(
      (el) =>
        el.getAttribute('data-model-picker-nav') ?? el.getAttribute('data-model-picker-vendor')
    );
    expect(order[0]).toBe('favorites');
    expect(order[1]).toBe('recent');
    expect(order.length).toBeGreaterThan(2);
    expect(q('[data-model-picker-nav="recent"]')?.textContent).toContain('10');

    await act(async () => q('[data-model-picker-nav="recent"]')?.click());
    expect(recentRemoveKeys()).toEqual(
      ['m12', 'm11', 'm10', 'm9', 'm8', 'm7', 'm6', 'm5', 'm4', 'm3'].map((id) =>
        pinnedModelKey('many', id)
      )
    );
  });

  it('移除按钮只移除该条，不触发切换模型、不关闭弹层、不影响星标', async () => {
    harness.pinnedModels = [pinnedModelKey('relay', 'rl')];
    harness.recentModels = [ref('relay', 'rl'), ref('gateway', 'gw')];
    harness.removeRecentModel.mockImplementation((target: ModelRef) => {
      harness.recentModels = harness.recentModels.filter(
        (entry) => entry.providerId !== target.providerId || entry.modelId !== target.modelId
      );
    });
    await mount();
    await act(async () => harness.menuOnOpenChange?.(true, openDetails));
    await act(async () => q('[data-model-picker-nav="recent"]')?.click());

    const remove = q(
      `[data-model-recent-remove="${pinnedModelKey('relay', 'rl')}"]`
    ) as HTMLElement;
    expect(remove.tagName).toBe('SPAN');
    expect(remove.getAttribute('role')).toBe('button');
    expect(remove.className).toContain('opacity-0');
    expect(remove.className).toContain('group-hover:opacity-100');
    expect(remove.closest('button')).toBeNull();

    await act(async () => remove.click());
    expect(harness.removeRecentModel).toHaveBeenCalledWith(ref('relay', 'rl'));
    expect(commonProps.onSelect).not.toHaveBeenCalled();
    expect(harness.togglePinnedModel).not.toHaveBeenCalled();
    expect(harness.menuOpen).toBe(true);

    await mount();
    expect(active('[data-model-picker-nav="recent"]')).toBe(true);
    expect(recentRemoveKeys()).toEqual([pinnedModelKey('gateway', 'gw')]);
    expect(q('[data-model-picker-nav="favorites"]')).not.toBeNull();
    expect(harness.pinnedModels).toEqual([pinnedModelKey('relay', 'rl')]);
    harness.removeRecentModel.mockReset();
  });

  it('移除最后一条后整组消失，右栏退回当前选中厂商', async () => {
    harness.recentModels = [ref('relay', 'rl')];
    await mount();
    await act(async () => harness.menuOnOpenChange?.(true, openDetails));
    await act(async () => q('[data-model-picker-nav="recent"]')?.click());
    harness.recentModels = [];
    await mount();
    expect(q('[data-model-picker-nav="recent"]')).toBeNull();
    expect(q('[data-model-picker="recent-list"]')).toBeNull();
    expect(active('[data-model-picker-vendor="__custom:gateway"]')).toBe(true);
  });
});

describe('resolveActiveWorkbenchView 最近使用', () => {
  const group: ProviderGroup = {
    vendorId: 'custom',
    label: 'Custom',
    providers: [pickerProvider('gateway', 'Gateway')],
  };
  const base = {
    groups: [group],
    selectableVirtualModels: [],
    pinnedCount: 0,
    selectedProviderId: 'gateway',
  };

  it('显式选中且有条目时停在最近使用，空时退回厂商', () => {
    const recent = resolveActiveWorkbenchView({
      ...base,
      recentCount: 2,
      activeNav: { kind: 'recent' },
    });
    expect(recent.activeNav).toEqual({ kind: 'recent' });
    expect(recent.showRecentNav).toBe(true);
    expect(recent.activeGroup).toBeUndefined();

    const stale = resolveActiveWorkbenchView({
      ...base,
      recentCount: 0,
      activeNav: { kind: 'recent' },
    });
    expect(stale.showRecentNav).toBe(false);
    expect(stale.activeNav).toEqual({ kind: 'vendor', vendorId: 'custom' });
  });

  it('未显式选择时不抢默认落点', () => {
    const view = resolveActiveWorkbenchView({ ...base, recentCount: 3, activeNav: null });
    expect(view.activeNav).toEqual({ kind: 'vendor', vendorId: 'custom' });
  });
});

describe('ModelPicker 单个服务商刷新', () => {
  const listModels = vi.fn();
  const openDetails = { cancel() {}, allowPropagation() {} };
  const gateway = pickerProvider('gateway', 'Gateway');
  const relay: ModelProvider = {
    ...pickerProvider('relay', 'Relay'),
    baseUrl: 'https://relay.example.test/v1',
    models: [{ id: 'rl', label: 'Relay model' }],
  };
  const auto: VirtualModelEntry = {
    id: 'auto',
    name: 'Auto route',
    enabled: true,
    primary: { providerId: 'gateway', modelId: 'm' },
    fallbacks: [],
  };
  let doc: Document;
  let root: Root;

  async function mount(recent = false) {
    if (recent) harness.recentModels = [{ providerId: 'relay', modelId: 'rl' }];
    await act(async () => {
      root.render(
        createElement(ModelPicker, {
          ...commonProps,
          providers: [gateway, relay],
          providerId: 'gateway',
          modelId: 'm',
          virtualModels: [auto],
        })
      );
    });
    await act(async () => harness.menuOnOpenChange?.(true, openDetails));
  }

  const q = (selector: string) => doc.querySelector(selector) as HTMLElement | null;
  const active = (selector: string) =>
    (q(selector)?.className.split(/\s+/) ?? []).includes('bg-accent');

  beforeEach(() => {
    listModels.mockReset();
    resetProviderFetchStates();
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    Object.assign(dom.window, {
      electronAPI: { providers: { listOauth: () => Promise.resolve([]), listModels } },
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    doc = dom.document as unknown as Document;
    root = createRoot(dom.document.getElementById('root') as unknown as HTMLElement);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    harness.recentModels = [];
    resetProviderFetchStates();
    vi.unstubAllGlobals();
  });

  it('厂商行有刷新控件，星标与最近使用没有', async () => {
    await mount(true);
    expect(q('[data-model-picker-nav-refresh="__custom:gateway"]')).not.toBeNull();
    expect(q('[data-model-picker-nav-refresh="__custom:relay"]')).not.toBeNull();
    expect(
      q('[data-model-picker-nav="favorites"]')?.querySelector('[data-model-picker-nav-refresh]')
    ).toBeNull();
    expect(
      q('[data-model-picker-nav="recent"]')?.querySelector('[data-model-picker-nav-refresh]')
    ).toBeNull();
    expect(q('[data-model-picker-nav-refresh="__custom:relay"]')?.getAttribute('title')).toBe(
      'Refresh provider models'
    );
  });

  it('点击刷新只拉取该厂商，不改变导航、选中和弹层', async () => {
    listModels.mockResolvedValue({ ok: true, models: [{ id: 'rl' }] });
    await mount();
    await act(async () => q('[data-model-picker-nav-refresh="__custom:relay"]')?.click());
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(listModels).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://relay.example.test/v1' })
    );
    expect(commonProps.onSelect).not.toHaveBeenCalled();
    expect(harness.menuOpen).toBe(true);
    expect(active('[data-model-picker-vendor="__custom:gateway"]')).toBe(true);
    expect(active('[data-model-picker-vendor="__custom:relay"]')).toBe(false);
  });

  it('刷新中按钮呈转动', async () => {
    let release!: (value: { ok: boolean; models: [] }) => void;
    listModels.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    await mount();
    await act(async () => {
      q('[data-model-picker-nav-refresh="__custom:gateway"]')?.click();
    });
    expect(q('[data-model-picker-nav-refresh="__custom:gateway"]')?.innerHTML ?? '').toContain(
      'animate-spin'
    );
    release({ ok: true, models: [] });
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('失败时刷新按钮带错误色和原因', async () => {
    listModels.mockResolvedValue({ ok: false, models: [], error: 'unauthorized' });
    await mount();
    await act(async () => q('[data-model-picker-nav-refresh="__custom:gateway"]')?.click());
    const refresh = q('[data-model-picker-nav-refresh="__custom:gateway"]') as HTMLElement;
    expect(`${refresh.className} ${refresh.innerHTML}`).toContain('text-destructive');
    expect(refresh.getAttribute('title')).toContain('unauthorized');
    expect(refresh.getAttribute('title')).toContain('Refresh failed');
  });
});
