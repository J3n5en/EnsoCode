import type { ModelProvider, SubagentModelEntry } from '@shared/types';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBAGENT_ROLE_PRESETS } from './subagentModelPresets';

const harness = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  providers: [] as unknown[],
  pickerProps: [] as Record<string, unknown>[],
  switchProps: [] as Record<string, unknown>[],
  updateEntry: vi.fn(),
  moveEntry: vi.fn(),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name])),
  }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(harness.state),
}));
vi.mock('@/stores/modelDirectory/useProviders', () => ({
  useUsableProviders: () => harness.providers,
}));
vi.mock('@/components/chat/ModelPicker', () => ({
  MODEL_PICKER_FORM_TRIGGER_CLASS: 'form-trigger',
  ModelPicker: (props: Record<string, unknown>) => {
    harness.pickerProps.push(props);
    return <i data-model-picker="true" />;
  },
}));
vi.mock('@/components/ui/switch', () => ({
  Switch: (props: Record<string, unknown>) => {
    harness.switchProps.push(props);
    return <i data-slot={props['data-slot'] as string} />;
  },
}));
vi.mock('@/components/ui/textarea', () => ({
  Textarea: ({ size: _size, ...props }: ComponentProps<'textarea'> & { size?: string }) => (
    <textarea {...props} />
  ),
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock('./kit', () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ children, label }: { children?: ReactNode; label: ReactNode }) => (
    <div data-row="true">
      {label}
      {children}
    </div>
  ),
  SettingsSwitch: () => <i />,
  SettingsEmptyState: ({ title, actions }: { title: ReactNode; actions?: ReactNode }) => (
    <div data-empty="true">
      {title}
      {actions}
    </div>
  ),
  SettingsButton: ({ variant: _v, ...props }: ComponentProps<'button'> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
  SettingsExpandableRow: function Expandable({
    label,
    children,
    defaultOpen = false,
  }: {
    label: ReactNode;
    children?: ReactNode;
    defaultOpen?: boolean;
  }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
      <div data-expandable="true">
        <button type="button" data-toggle="true" onClick={() => setOpen(!open)}>
          {label}
        </button>
        {open && <div data-region="true">{children}</div>}
      </div>
    );
  },
  SettingsSegmented: () => null,
}));

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

function entry(id: string, overrides: Partial<SubagentModelEntry> = {}): SubagentModelEntry {
  return { id, providerId: 'api', modelId: 'model', description: id, ...overrides };
}

let root: Root;
let container: HTMLElement;
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
};
const rows = () => [...container.querySelectorAll('[data-slot="subagent-model-row"]')];
const editors = () => container.querySelectorAll('[data-slot="subagent-model-editor"]');
const editButton = (row: Element) => row.querySelector('[data-slot="subagent-model-edit"]');

async function renderEntries(entries: SubagentModelEntry[]) {
  harness.state = {
    subagentModelsEnabled: true,
    subagentModels: entries,
    setSubagentModelsEnabled: vi.fn(),
    addSubagentModel: (input: Omit<SubagentModelEntry, 'id'>) => {
      const created = { id: 'new', ...input };
      harness.state.subagentModels = [...(harness.state.subagentModels as []), created];
      return created;
    },
    updateSubagentModel: harness.updateEntry,
    removeSubagentModel: vi.fn(),
    moveSubagentModel: harness.moveEntry,
    setSubagentModels: vi.fn(),
    virtualModels: [],
    defaultModel: { providerId: 'api', modelId: 'model' },
  };
  await act(async () => root.render(<SubagentModelsSettings />));
}

/** 逐行点开编辑，取每行编辑态里 ModelPicker 的最新 props */
async function editorPickerProps(entries: SubagentModelEntry[]) {
  await renderEntries(entries);
  const result: Record<string, unknown>[] = [];
  for (const row of rows()) {
    await click(editButton(row));
    const latest = harness.pickerProps.at(-1);
    if (latest) result.push(latest);
  }
  return result;
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent: vi.fn(), detachEvent: vi.fn() });
  Object.defineProperty(dom.window.HTMLTextAreaElement.prototype, 'defaultValue', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return this.textContent ?? '';
    },
    set(this: HTMLTextAreaElement, value: string) {
      this.textContent = value;
    },
  });
  harness.providers = providers;
  harness.pickerProps = [];
  harness.switchProps = [];
  harness.updateEntry.mockClear();
  harness.moveEntry.mockClear();
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('SubagentModelsSettings 展示态', () => {
  it('默认只读展示：模型名、推理摘要和完整描述文字，没有下拉框、文本框和排序按钮', async () => {
    await renderEntries([
      entry('a', { description: '很长的选型说明\n第二行', reasoning: 'on', thinkingLevel: 'high' }),
      entry('b', { reasoning: 'off' }),
      entry('c'),
    ]);
    const [a, b, c] = rows();
    expect(a.querySelector('[data-slot="subagent-model-name"]')?.textContent).toBe(
      'API entry / Chosen model'
    );
    expect(a.querySelector('[data-slot="subagent-model-reasoning"]')?.textContent).toBe(
      'On · High'
    );
    expect(b.querySelector('[data-slot="subagent-model-reasoning"]')?.textContent).toBe('Off');
    expect(c.querySelector('[data-slot="subagent-model-reasoning"]')?.textContent).toBe(
      'Follow parent'
    );
    expect(a.querySelector('[data-slot="subagent-model-description-text"]')?.textContent).toBe(
      '很长的选型说明\n第二行'
    );
    expect(container.querySelector('[data-model-picker]')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('[aria-label="Move up"]')).toBeNull();
    expect(a.querySelector('[aria-label="Delete"]')).toBeTruthy();
    expect(harness.switchProps.map((props) => props['aria-label'])).toEqual([
      'Enable subagent model',
      'Enable subagent model',
      'Enable subagent model',
    ]);
  });

  it('空描述显示淡色引导文字', async () => {
    await renderEntries([entry('blank', { description: '  ' })]);
    expect(
      rows()[0].querySelector('[data-slot="subagent-model-description-text"]')?.textContent
    ).toBe('Click to add a description…');
  });

  it('同一模型多个启用条目从第二条起显示运行时后缀，停用条目不占序号', async () => {
    await renderEntries([entry('a'), entry('off', { enabled: false }), entry('b'), entry('c')]);
    const [a, b, c] = rows();
    expect(a.innerHTML).not.toContain('>#');
    expect(b.innerHTML).toContain('>#2<');
    expect(c.innerHTML).toContain('>#3<');
  });

  it('首选兜底标在第一个启用且可用的条目上，不可用条目标「模型不可用」且不计序号', async () => {
    await renderEntries([entry('ghost', { modelId: 'ghost' }), entry('first'), entry('second')]);
    const [ghost, first, second] = rows();
    expect(ghost.textContent).toContain('Model unavailable');
    expect(ghost.textContent).toContain('API entry / ghost');
    expect(ghost.textContent).not.toContain('Preferred fallback');
    expect(first.textContent).toContain('Preferred fallback');
    expect(first.innerHTML).not.toContain('>#');
    expect(second.textContent).not.toContain('Preferred fallback');
    expect(second.innerHTML).toContain('>#2<');
  });

  it('停用条目收进「已停用 (N)」分组：有启用条目时默认折叠，展开后同样是紧凑行', async () => {
    await renderEntries([
      entry('a'),
      entry('x', { enabled: false }),
      entry('y', { enabled: false }),
    ]);
    expect(container.textContent).toContain('Disabled (2)');
    expect(rows()).toHaveLength(1);
    await click(container.querySelector('[data-toggle]'));
    expect(rows()).toHaveLength(3);
    expect(editors()).toHaveLength(0);

    await renderEntries([entry('x', { enabled: false })]);
    expect(rows()).toHaveLength(1);
  });

  it('开启但列表为空时显示向导与手动添加两个入口', async () => {
    await renderEntries([]);
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain('Quick setup wizard');
    expect(container.textContent).toContain('Add model manually');
  });
});

describe('SubagentModelsSettings 内联编辑', () => {
  it('点行主体或铅笔切换展开，同一时间只展开一条', async () => {
    await renderEntries([entry('a'), entry('b')]);
    const [a, b] = rows();
    await click(a.querySelector('[data-slot="subagent-model-summary"]'));
    expect(editors()).toHaveLength(1);
    expect(rows()[0].querySelector('[data-slot="subagent-model-editor"]')).toBeTruthy();
    expect(rows()[0].querySelector('[aria-label="Move up"]')).toBeTruthy();
    expect(rows()[0].querySelector('textarea')?.value).toBe('a');

    await click(editButton(b));
    expect(editors()).toHaveLength(1);
    expect(rows()[1].querySelector('[data-slot="subagent-model-editor"]')).toBeTruthy();

    await click(rows()[1].querySelector('[data-slot="subagent-model-done"]'));
    expect(editors()).toHaveLength(0);
  });

  it('编辑态选模型只写该行的 provider 与 model', async () => {
    await renderEntries([entry('a'), entry('b')]);
    await click(editButton(rows()[1]));
    (harness.pickerProps.at(-1)!.onSelect as (providerId: string, modelId: string) => void)(
      'api',
      'other'
    );
    expect(harness.updateEntry.mock.calls).toEqual([
      ['b', { providerId: 'api', modelId: 'other' }],
    ]);
  });

  it('编辑态的上下移动按组内位置禁用首尾', async () => {
    await renderEntries([entry('a'), entry('b')]);
    await click(editButton(rows()[0]));
    const up = rows()[0].querySelector('[aria-label="Move up"]') as HTMLButtonElement;
    const down = rows()[0].querySelector('[aria-label="Move down"]') as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    expect(down.disabled).toBe(false);
    await click(down);
    expect(harness.moveEntry.mock.calls).toEqual([['a', 'down']]);
  });

  it('添加模型后新条目自动展开编辑', async () => {
    await renderEntries([entry('a')]);
    await click(container.querySelector('[data-slot="subagent-models-add"]'));
    expect(rows()).toHaveLength(2);
    expect(editors()).toHaveLength(1);
    expect(rows()[1].querySelector('[data-slot="subagent-model-editor"]')).toBeTruthy();
  });

  it('编辑态给出五个角色模板标签，点击填入对应模板', async () => {
    await renderEntries([entry('blank', { description: '' })]);
    await click(editButton(rows()[0]));
    const chips = [...container.querySelectorAll('[data-slot="subagent-model-template-chip"]')];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'scout research',
      'worker build',
      'reviewer review',
      'tester tests',
      'light errands',
    ]);
    await click(chips[2]);
    const reviewer = SUBAGENT_ROLE_PRESETS.find((role) => role.id === 'reviewer');
    expect(harness.updateEntry.mock.calls).toEqual([
      ['blank', { description: reviewer?.template }],
    ]);
  });

  it('单行停用再启用只写 enabled', async () => {
    await renderEntries([
      entry('configured', { reasoning: 'on', thinkingLevel: 'high' }),
      entry('other'),
    ]);
    const change = harness.switchProps.at(-2)?.onCheckedChange as (enabled: boolean) => void;
    change(false);
    change(true);
    expect(harness.updateEntry.mock.calls).toEqual([
      ['configured', { enabled: false }],
      ['configured', { enabled: true }],
    ]);
  });
});

describe('SubagentModelsSettings reasoning controls', () => {
  it.each([undefined, 'on'] as const)(
    '缺深度的旧数据只在点击 On 后原子初始化推理和支持档位：%s',
    async (reasoning) => {
      const [props] = await editorPickerProps([entry('configured', { reasoning })]);
      expect(harness.updateEntry).not.toHaveBeenCalled();
      (props.onReasoningModeChange as (mode: string, level: string) => void)('on', 'high');
      expect(harness.updateEntry.mock.calls).toEqual([
        ['configured', { reasoning: 'on', thinkingLevel: 'high' }],
      ]);
    }
  );

  it('将合法条目能力覆盖传给当前模型，空或脏字段不遮盖模型行', async () => {
    const props = await editorPickerProps([
      entry('configured', { reasoning: 'on', thinkingLevel: 'max' }),
      entry('follow'),
      entry('dirty', { reasoning: 'maybe' as never, thinkingLevel: 'ultra' as never }),
    ]);
    expect(props.map((p) => p.modelCapabilityOverrides)).toEqual([
      { reasoning: 'on', thinkingLevel: 'max' },
      {},
      {},
    ]);
  });

  it('旧部分覆盖与脏值仅映射三态，渲染不改写', async () => {
    const props = await editorPickerProps([
      entry('follow'),
      entry('level-only', { thinkingLevel: 'low' }),
      entry('reasoning-only', { reasoning: 'off' }),
      entry('explicit', { reasoning: 'on', thinkingLevel: 'high' }),
      entry('dirty', { reasoning: 'maybe' as never, thinkingLevel: 'ultra' as never }),
    ]);
    expect(props.map((p) => p.reasoningMode)).toEqual(['follow', 'follow', 'off', 'on', 'follow']);
    expect(
      rows().map((row) => row.querySelector('[data-slot="subagent-model-reasoning"]')?.textContent)
    ).toEqual(['Follow parent', 'Follow parent', 'Off', 'On · High', 'Follow parent']);
    expect(harness.updateEntry).not.toHaveBeenCalled();
  });

  it('停用条目展开编辑时保留模型与推理配置', async () => {
    await renderEntries([
      entry('disabled', { enabled: false, reasoning: 'off', thinkingLevel: 'high' }),
    ]);
    expect(harness.switchProps.at(-1)?.checked).toBe(false);
    await click(editButton(rows()[0]));
    expect(harness.pickerProps.at(-1)).toMatchObject({
      reasoningEnabled: false,
      thinkingLevel: 'high',
    });
    expect(harness.updateEntry).not.toHaveBeenCalled();
  });

  it('仅设置档位不把推理开关继承归一化为显式值，用户调档也只写档位', async () => {
    const [props] = await editorPickerProps([entry('level-only', { thinkingLevel: 'low' })]);
    (props.onReasoningNormalize as (enabled: boolean) => void)(false);
    (props.onThinkingChange as (level: string) => void)('high');
    expect(harness.updateEntry.mock.calls).toEqual([['level-only', { thinkingLevel: 'high' }]]);
  });

  it('缺省与脏覆盖用 follow 三态，不传伪装父会话状态的全局默认', async () => {
    const props = await editorPickerProps([
      entry('follow'),
      entry('forced-on', { reasoning: 'on', thinkingLevel: 'low' }),
      entry('forced-off', { reasoning: 'off', thinkingLevel: 'high' }),
      entry('dirty', { reasoning: 'maybe' as never, thinkingLevel: 'ultra' as never }),
    ]);
    expect(props[0]).toMatchObject({ reasoningMode: 'follow', reasoningEnabled: false });
    expect(props[1]).toMatchObject({
      reasoningMode: 'on',
      reasoningEnabled: true,
      thinkingLevel: 'low',
    });
    expect(props[2]).toMatchObject({
      reasoningMode: 'off',
      reasoningEnabled: false,
      thinkingLevel: 'high',
    });
    expect(props[3]).toMatchObject({ reasoningMode: 'follow', reasoningEnabled: false });
  });

  it('继承项忽略自动归一化，只有用户操作才形成独立 override', async () => {
    const [props] = await editorPickerProps([entry('follow')]);
    (props.onReasoningNormalize as (enabled: boolean) => void)(false);
    (props.onThinkingNormalize as (level: string) => void)('high');
    expect(harness.updateEntry).not.toHaveBeenCalled();
    (props.onReasoningChange as (enabled: boolean) => void)(true);
    (props.onThinkingChange as (level: string) => void)('low');
    expect(harness.updateEntry.mock.calls).toEqual([
      ['follow', { reasoning: 'on' }],
      ['follow', { thinkingLevel: 'low' }],
    ]);
  });

  it('已有独立 override 接受能力归一化，关开推理时保留最后档位', async () => {
    const [props] = await editorPickerProps([
      entry('configured', { reasoning: 'on', thinkingLevel: 'high' }),
    ]);
    (props.onReasoningNormalize as (enabled: boolean) => void)(false);
    (props.onThinkingNormalize as (level: string) => void)('low');
    const modeChange = props.onReasoningModeChange as (mode: string, level: string) => void;
    modeChange('off', 'medium');
    modeChange('on', 'medium');
    expect(harness.updateEntry.mock.calls).toEqual([
      ['configured', { reasoning: 'off' }],
      ['configured', { thinkingLevel: 'low' }],
      ['configured', { reasoning: 'off' }],
      ['configured', { reasoning: 'on' }],
    ]);
  });

  it('选择 Follow parent 明确清除两项', async () => {
    const [props] = await editorPickerProps([
      entry('configured', { reasoning: 'on', thinkingLevel: 'high' }),
    ]);
    (props.onReasoningModeChange as (mode: string, level: string) => void)('follow', 'medium');
    expect(harness.updateEntry).toHaveBeenCalledWith('configured', {
      reasoning: undefined,
      thinkingLevel: undefined,
    });
  });
});
