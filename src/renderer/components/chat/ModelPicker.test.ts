import type {
  ModelEntry,
  ModelMeta,
  ModelProvider,
  OauthAccountUsage,
  ThinkingLevel,
} from '@shared/types';
import { VIRTUAL_PROVIDER_ID, type VirtualModelEntry } from '@shared/virtualModels';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker, persistClampedThinkingLevel, resolvePickerCapabilities } from './ModelPicker';

interface WrapperProps {
  children?: ReactNode;
}

interface ClickWrapperProps extends WrapperProps {
  onClick?: () => void;
}

const harness = vi.hoisted(() => ({
  menuItemClicks: [] as Array<() => void>,
  sliderProps: null as Record<string, unknown> | null,
  switchProps: null as Record<string, unknown> | null,
  buttons: [] as Record<string, unknown>[],
  meta: {} as Record<string, unknown>,
  usageAccountKeys: [] as string[],
  usageData: {} as Record<string, OauthAccountUsage>,
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
  const MenuItem = ({ children, onClick }: ClickWrapperProps) => {
    if (onClick) harness.menuItemClicks.push(onClick);
    return createElement('div', null, children);
  };
  const MenuTrigger = ({ children, title }: WrapperProps & { title?: string }) =>
    createElement('button', { type: 'button', title }, children);
  return {
    Menu: Wrap,
    MenuGroup: Wrap,
    MenuGroupLabel: Wrap,
    MenuItem,
    MenuPopup: Wrap,
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

vi.mock('@/components/ui/slider', () => ({
  Slider: (props: Record<string, unknown>) => {
    harness.sliderProps = props;
    return createElement('i', { 'data-slider': 'true' });
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
  harness.sliderProps = null;
  harness.switchProps = null;
  harness.buttons = [];
  harness.meta = {};
  harness.usageAccountKeys = [];
  harness.usageData = {};
  commonProps.onSelect.mockClear();
  commonProps.onReasoningChange.mockClear();
  commonProps.onThinkingChange.mockClear();
});

describe('ModelPicker reasoning controls mode', () => {
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
    renderToStaticMarkup(
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
    expect(harness.sliderProps?.max).toBe(5);
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
    expect(html.includes('data-slider="true"')).toBe(slider);
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
    expect(html).toContain('data-slider="true"');
    expect(html).not.toContain('Customize');
    expect(harness.buttons.filter((button) => button['data-slot'] === 'follow-depth')).toHaveLength(
      0
    );
    expect(harness.sliderProps?.value).toBe(2);
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
  ])('刻度与滑块共用完整轨道百分比，单档不除零：%j', (...levels) => {
    harness.meta = {
      model: { modelId: 'model', source: 'catalog', reasoning: true, thinkingLevels: levels },
    };
    for (const [index, thinkingLevel] of levels.entries()) {
      const html = renderToStaticMarkup(
        createElement(ModelPicker, { ...commonProps, thinkingLevel })
      );
      expect(harness.sliderProps).toMatchObject({
        thumbAlignment: 'center',
        min: 0,
        max: Math.max(1, levels.length - 1),
        value: index,
        disabled: levels.length === 1,
      });
      expect(harness.sliderProps?.className).toContain('[&_[data-slot=slider-indicator]]:ms-0');
      const tickStyles = [...html.matchAll(/data-thinking-tick="[^"]+"[^>]*style="([^"]+)"/g)];
      expect(tickStyles.map((match) => match[1])).toEqual(
        levels.map((_, tickIndex) => `left:${(tickIndex / Math.max(1, levels.length - 1)) * 100}%`)
      );
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
    renderToStaticMarkup(
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
    expect(harness.sliderProps?.max).toBe(max);
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
    expect(html).toContain('data-slider="true"');
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
        providerId: VIRTUAL_PROVIDER_ID,
        modelId: virtual.id,
        virtualModels: [virtual],
        thinkingLevel: 'max',
      })
    );
    expect(harness.switchProps?.checked).toBe(true);
    expect(harness.sliderProps).toMatchObject({ min: 0, max: 1, value: 1 });
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
    expect(html).not.toContain('data-slider="true"');
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
    harness.sliderProps = null;
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

    const sliderProps = harness.sliderProps as Record<string, unknown> | null;
    const onValueChange = sliderProps?.onValueChange;
    if (typeof onValueChange === 'function') onValueChange(1);
    expect(onThinkingChange).toHaveBeenCalledWith('low');
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
    expect(html).not.toContain('data-slider="true"');
    expect(html).not.toContain('>Med<');
  });
});
