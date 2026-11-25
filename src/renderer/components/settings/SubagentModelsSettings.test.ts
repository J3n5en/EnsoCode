import type { ModelProvider, SubagentModelEntry } from '@shared/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentModelsSettings } from './SubagentModelsSettings';

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
  state: {} as Record<string, unknown>,
  pickerProps: [] as Record<string, unknown>[],
  entrySwitchProps: [] as Record<string, unknown>[],
  followClicks: [] as Array<() => void>,
  updateEntry: vi.fn(),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(harness.state),
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

vi.mock('@/components/ui/button', () => ({
  Button: (props: Record<string, unknown>) => {
    if (props['data-slot'] === 'subagent-model-follow' && typeof props.onClick === 'function') {
      harness.followClicks.push(props.onClick as () => void);
    }
    return createElement('button', { type: 'button', 'data-slot': props['data-slot'] });
  },
}));

vi.mock('@/components/chat/ModelPicker', () => ({
  MODEL_PICKER_FORM_TRIGGER_CLASS: 'form-trigger',
  ModelPicker: (props: Record<string, unknown>) => {
    harness.pickerProps.push(props);
    return createElement('i', { 'data-model-picker': 'true' });
  },
}));

vi.mock('@/components/ui/switch', () => ({
  Switch: (props: Record<string, unknown>) => {
    if (props['data-slot'] === 'subagent-model-enabled') harness.entrySwitchProps.push(props);
    return createElement('i', { 'data-switch': props['data-slot'] });
  },
}));

function entry(id: string, overrides: Partial<SubagentModelEntry> = {}): SubagentModelEntry {
  return {
    id,
    providerId: 'api',
    modelId: 'model',
    description: id,
    ...overrides,
  };
}

function renderEntries(entries: SubagentModelEntry[]) {
  harness.state = {
    providers,
    subagentModelsEnabled: true,
    subagentModels: entries,
    setSubagentModelsEnabled: vi.fn(),
    addSubagentModel: vi.fn(),
    updateSubagentModel: harness.updateEntry,
    removeSubagentModel: vi.fn(),
    defaultModel: { providerId: 'api', modelId: 'model' },
    defaultReasoningEnabled: true,
    defaultThinkingLevel: 'max',
  };
  return renderToStaticMarkup(createElement(SubagentModelsSettings));
}

beforeEach(() => {
  harness.pickerProps = [];
  harness.entrySwitchProps = [];
  harness.followClicks = [];
  harness.updateEntry.mockClear();
});

describe('SubagentModelsSettings reasoning controls', () => {
  it.each([undefined, 'on'] as const)(
    '缺深度的旧数据只在点击 On 后原子初始化推理和支持档位：%s',
    (reasoning) => {
      renderEntries([entry('configured', { reasoning })]);
      expect(harness.updateEntry).not.toHaveBeenCalled();
      const change = harness.pickerProps[0].onReasoningModeChange;
      expect(change).toBeTypeOf('function');
      (change as (mode: string, level: string) => void)('on', 'high');
      expect(harness.updateEntry.mock.calls).toEqual([
        ['configured', { reasoning: 'on', thinkingLevel: 'high' }],
      ]);
    }
  );

  it('将合法条目能力覆盖传给当前模型，空或脏字段不遮盖模型行', () => {
    renderEntries([
      entry('configured', { reasoning: 'on', thinkingLevel: 'max' }),
      entry('follow'),
      entry('dirty', { reasoning: 'maybe' as never, thinkingLevel: 'ultra' as never }),
    ]);
    expect(harness.pickerProps.map((props) => props.modelCapabilityOverrides)).toEqual([
      { reasoning: 'on', thinkingLevel: 'max' },
      {},
      {},
    ]);
  });

  it('旧条目默认启用，显式停用仍保留可编辑的模型与推理配置', () => {
    const html = renderEntries([
      entry('legacy'),
      entry('disabled', { enabled: false, reasoning: 'off', thinkingLevel: 'high' }),
    ]);
    expect(harness.entrySwitchProps.map((props) => props.checked)).toEqual([true, false]);
    expect(harness.entrySwitchProps[0]['aria-label']).toBe('Enable subagent model');
    expect(harness.pickerProps).toHaveLength(2);
    expect(harness.pickerProps[1]).toMatchObject({
      reasoningEnabled: false,
      thinkingLevel: 'high',
    });
    expect(harness.updateEntry).not.toHaveBeenCalled();
    expect(html).toContain('Disabled');
    expect(html).toContain('Applies to newly started conversations.');
  });

  it('单行停用再启用只写 enabled，不改其它行或遗失该行模型与推理档位', () => {
    const configured = entry('configured', { reasoning: 'on', thinkingLevel: 'high' });
    const other = entry('other', { reasoning: 'off', thinkingLevel: 'low' });
    renderEntries([configured, other]);
    expect(harness.entrySwitchProps).toHaveLength(2);
    const change = harness.entrySwitchProps[0].onCheckedChange as (enabled: boolean) => void;
    change(false);
    change(true);
    expect(harness.updateEntry.mock.calls).toEqual([
      ['configured', { enabled: false }],
      ['configured', { enabled: true }],
    ]);
    expect(configured).toEqual(entry('configured', { reasoning: 'on', thinkingLevel: 'high' }));
    expect(other).toEqual(entry('other', { reasoning: 'off', thinkingLevel: 'low' }));
  });

  it('旧部分覆盖与脏值仅映射三态，渲染不改写', () => {
    renderEntries([
      entry('follow'),
      entry('level-only', { thinkingLevel: 'low' }),
      entry('reasoning-only', { reasoning: 'off' }),
      entry('explicit', { reasoning: 'on', thinkingLevel: 'high' }),
      entry('dirty', { reasoning: 'maybe' as never, thinkingLevel: 'ultra' as never }),
    ]);
    expect(harness.pickerProps.map((props) => props.reasoningMode)).toEqual([
      'follow',
      'follow',
      'off',
      'on',
      'follow',
    ]);
    expect(harness.updateEntry).not.toHaveBeenCalled();
  });

  it('仅设置档位不把推理开关继承归一化为显式值，用户调档也只写档位', () => {
    renderEntries([entry('level-only', { thinkingLevel: 'low' })]);
    const props = harness.pickerProps[0];
    (props.onReasoningNormalize as (enabled: boolean) => void)(false);
    (props.onThinkingChange as (level: string) => void)('high');
    expect(harness.updateEntry.mock.calls).toEqual([['level-only', { thinkingLevel: 'high' }]]);
  });

  it('缺省与脏覆盖用 follow 三态，不传伪装父会话状态的全局默认', () => {
    renderEntries([
      entry('follow'),
      entry('forced-on', { reasoning: 'on', thinkingLevel: 'low' }),
      entry('forced-off', { reasoning: 'off', thinkingLevel: 'high' }),
      entry('dirty', {
        reasoning: 'maybe' as SubagentModelEntry['reasoning'],
        thinkingLevel: 'ultra' as SubagentModelEntry['thinkingLevel'],
      }),
    ]);

    expect(harness.pickerProps).toHaveLength(4);
    expect(harness.pickerProps[0]).toMatchObject({
      reasoningMode: 'follow',
      reasoningEnabled: false,
    });
    expect(harness.pickerProps[1]).toMatchObject({
      reasoningMode: 'on',
      reasoningEnabled: true,
      thinkingLevel: 'low',
    });
    expect(harness.pickerProps[2]).toMatchObject({
      reasoningMode: 'off',
      reasoningEnabled: false,
      thinkingLevel: 'high',
    });
    expect(harness.pickerProps[3]).toMatchObject({
      reasoningMode: 'follow',
      reasoningEnabled: false,
    });
  });

  it('继承项忽略自动归一化，只有用户操作才形成独立 override', () => {
    renderEntries([entry('follow')]);
    const props = harness.pickerProps[0];

    const onReasoningNormalize = props.onReasoningNormalize;
    if (typeof onReasoningNormalize === 'function') onReasoningNormalize(false);
    const onThinkingNormalize = props.onThinkingNormalize;
    if (typeof onThinkingNormalize === 'function') onThinkingNormalize('high');
    expect(harness.updateEntry).not.toHaveBeenCalled();

    const onReasoningChange = props.onReasoningChange;
    if (typeof onReasoningChange === 'function') onReasoningChange(true);
    const onThinkingChange = props.onThinkingChange;
    if (typeof onThinkingChange === 'function') onThinkingChange('low');
    expect(harness.updateEntry.mock.calls).toEqual([
      ['follow', { reasoning: 'on' }],
      ['follow', { thinkingLevel: 'low' }],
    ]);
  });

  it('已有独立 override 接受能力归一化，关开推理时保留最后档位', () => {
    renderEntries([entry('configured', { reasoning: 'on', thinkingLevel: 'high' })]);
    const props = harness.pickerProps[0];

    const onReasoningNormalize = props.onReasoningNormalize;
    if (typeof onReasoningNormalize === 'function') onReasoningNormalize(false);
    const onThinkingNormalize = props.onThinkingNormalize;
    if (typeof onThinkingNormalize === 'function') onThinkingNormalize('low');
    const onReasoningModeChange = props.onReasoningModeChange;
    expect(onReasoningModeChange).toBeTypeOf('function');
    if (typeof onReasoningModeChange === 'function') {
      onReasoningModeChange('off', 'medium');
      onReasoningModeChange('on', 'medium');
    }

    expect(harness.updateEntry.mock.calls).toEqual([
      ['configured', { reasoning: 'off' }],
      ['configured', { thinkingLevel: 'low' }],
      ['configured', { reasoning: 'off' }],
      ['configured', { reasoning: 'on' }],
    ]);
  });

  it('选择 Follow parent 明确清除两项，不再显示冗余行复位按钮', () => {
    renderEntries([entry('follow')]);
    expect(harness.followClicks).toHaveLength(0);

    harness.pickerProps = [];
    renderEntries([entry('configured', { reasoning: 'on', thinkingLevel: 'high' })]);
    expect(harness.followClicks).toHaveLength(0);
    const follow = harness.pickerProps[0].onReasoningModeChange;
    expect(follow).toBeTypeOf('function');
    (follow as (mode: string, level: string) => void)('follow', 'medium');
    expect(harness.updateEntry).toHaveBeenCalledWith('configured', {
      reasoning: undefined,
      thinkingLevel: undefined,
    });
  });
});
