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
  ModelPicker: (props: Record<string, unknown>) => {
    harness.pickerProps.push(props);
    return createElement('i', { 'data-model-picker': 'true' });
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
  renderToStaticMarkup(createElement(SubagentModelsSettings));
}

beforeEach(() => {
  harness.pickerProps = [];
  harness.followClicks = [];
  harness.updateEntry.mockClear();
});

describe('SubagentModelsSettings reasoning controls', () => {
  it('缺省与脏覆盖继承全局默认，合法 on/off 和档位按条目独立优先', () => {
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
      reasoningEnabled: true,
      thinkingLevel: 'max',
    });
    expect(harness.pickerProps[1]).toMatchObject({
      reasoningEnabled: true,
      thinkingLevel: 'low',
    });
    expect(harness.pickerProps[2]).toMatchObject({
      reasoningEnabled: false,
      thinkingLevel: 'high',
    });
    expect(harness.pickerProps[3]).toMatchObject({
      reasoningEnabled: true,
      thinkingLevel: 'max',
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
    const onReasoningChange = props.onReasoningChange;
    if (typeof onReasoningChange === 'function') {
      onReasoningChange(false);
      onReasoningChange(true);
    }

    expect(harness.updateEntry.mock.calls).toEqual([
      ['configured', { reasoning: 'off' }],
      ['configured', { thinkingLevel: 'low' }],
      ['configured', { reasoning: 'off' }],
      ['configured', { reasoning: 'on' }],
    ]);
  });

  it('独立覆盖可复位为跟随会话，继承项不显示复位', () => {
    renderEntries([entry('follow')]);
    expect(harness.followClicks).toHaveLength(0);

    harness.pickerProps = [];
    renderEntries([entry('configured', { reasoning: 'on', thinkingLevel: 'high' })]);
    expect(harness.followClicks).toHaveLength(1);
    harness.followClicks[0]?.();
    expect(harness.updateEntry).toHaveBeenCalledWith('configured', {
      reasoning: undefined,
      thinkingLevel: undefined,
    });
  });
});
