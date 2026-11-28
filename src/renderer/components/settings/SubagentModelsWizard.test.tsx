import type { ModelProvider, SubagentModelEntry } from '@shared/types';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBAGENT_ROLE_PRESETS } from './subagentModelPresets';

const harness = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  providers: [] as unknown[],
  pickers: [] as Record<string, unknown>[],
  setEntries: vi.fn(),
  segmented: false,
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
    harness.pickers.push(props);
    return <i data-model-picker={String(props.modelId || props.emptyLabel)} />;
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
vi.mock('@/components/ui/dialog', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: passthrough,
    DialogContent: passthrough,
    DialogDescription: passthrough,
    DialogFooter: ({ children }: { children?: ReactNode }) => <footer>{children}</footer>,
    DialogHeader: passthrough,
    DialogPanel: passthrough,
    DialogTitle: passthrough,
  };
});
vi.mock('./kit', () => ({
  SettingsSegmented: () => {
    harness.segmented = true;
    return <i data-segmented="true" />;
  },
}));

import { SubagentModelsWizard } from './SubagentModelsWizard';

const providers: ModelProvider[] = [
  {
    id: 'api',
    name: 'API',
    api: 'openai-completions',
    apiKey: 'k',
    baseUrl: 'https://example.test/v1',
    enabled: true,
    models: [{ id: 'fast' }, { id: 'smart' }],
  },
];

let root: Root;
let container: HTMLElement;
const roles = () => [...container.querySelectorAll('[data-slot="subagent-wizard-role"]')];
const footer = () => container.querySelector('footer') as HTMLElement;
const confirmButton = () =>
  [...footer().querySelectorAll('button')].find((b) => b.textContent === 'Confirm') as
    | HTMLButtonElement
    | undefined;
/** 第 index 个角色当前一次渲染的 picker props */
const pickerOf = (index: number) => harness.pickers.slice(-SUBAGENT_ROLE_PRESETS.length)[index];

async function render(existing: SubagentModelEntry[] = []) {
  harness.state = {
    subagentModels: existing,
    setSubagentModels: harness.setEntries,
    virtualModels: [],
  };
  await act(async () => root.render(<SubagentModelsWizard onClose={vi.fn()} />));
}
async function pick(index: number, modelId: string) {
  await act(async () =>
    (pickerOf(index).onSelect as (providerId: string, modelId: string) => void)('api', modelId)
  );
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
  harness.pickers = [];
  harness.segmented = false;
  harness.setEntries.mockClear();
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const slot = (el: Element, name: string) =>
  el.querySelector(`[data-slot="subagent-wizard-${name}"]`) as HTMLElement | null;
async function clickEl(el: Element | null) {
  await act(async () => (el as HTMLElement).click());
}
/** 直接调用 React onChange，绕开 linkedom 不支持的受控输入事件 */
async function typeInto(el: Element, value: string) {
  const [, props] = Object.entries(el).find(([key]) => key.startsWith('__reactProps$')) as [
    string,
    { onChange: (event: { target: { value: string } }) => void },
  ];
  await act(async () => props.onChange({ target: { value } }));
}

describe('SubagentModelsWizard', () => {
  it('五个角色默认全部跳过：无动作按钮、无编辑区、无写入方式子栏，确认禁用', async () => {
    await render();
    expect(roles()).toHaveLength(5);
    expect(
      roles().map((role) =>
        role.querySelector('[data-model-picker]')?.getAttribute('data-model-picker')
      )
    ).toEqual(Array(5).fill('Skip this role'));
    for (const role of roles()) {
      expect(slot(role, 'tune')).toBeNull();
      expect(slot(role, 'skip')).toBeNull();
    }
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('[data-slot="subagent-wizard-mode"]')).toBeNull();
    expect(footer().textContent).toContain('Will add 0 models (skipping 5 roles)');
    expect(confirmButton()?.disabled).toBe(true);
    expect(harness.segmented).toBe(false);
  });

  it('已有列表时在写入方式子栏里给出追加/替换', async () => {
    await render([{ id: 'old', providerId: 'api', modelId: 'fast', description: 'old' }]);
    const bar = container.querySelector('[data-slot="subagent-wizard-mode"]');
    expect(bar?.textContent).toContain('Write mode');
    expect(bar?.querySelector('[data-segmented]')).not.toBeNull();
  });

  it('选中后收起态不重复显示描述，点铅笔才展开编辑区，完成收起', async () => {
    await render();
    await pick(1, 'smart');
    const template = SUBAGENT_ROLE_PRESETS[1].template;
    expect(roles()[1].textContent).not.toContain(template);
    expect(container.querySelector('textarea')).toBeNull();
    expect(slot(roles()[0], 'tune')).toBeNull();

    await clickEl(slot(roles()[1], 'tune'));
    expect(slot(roles()[1], 'tune')?.getAttribute('aria-expanded')).toBe('true');
    const editor = slot(roles()[1], 'editor');
    expect(editor?.textContent).toContain('Selection description');
    expect(editor?.querySelector('textarea')?.value).toBe(template);
    expect(slot(roles()[1], 'reset')).toBeNull();

    await clickEl(slot(roles()[1], 'done'));
    expect(slot(roles()[1], 'editor')).toBeNull();
    expect(footer().textContent).toContain('Will add 1 models (skipping 4 roles)');
  });

  it('改过描述显示「已自定义」，恢复默认回到模板', async () => {
    await render();
    await pick(2, 'smart');
    await clickEl(slot(roles()[2], 'tune'));
    await typeInto(roles()[2].querySelector('textarea') as Element, 'my review notes');
    expect(slot(roles()[2], 'customized')?.textContent).toBe('Customized');

    await clickEl(slot(roles()[2], 'reset'));
    expect(roles()[2].querySelector('textarea')?.value).toBe(SUBAGENT_ROLE_PRESETS[2].template);
    expect(slot(roles()[2], 'customized')).toBeNull();
  });

  it('清除按钮改回跳过并关闭编辑区；确认只写入已选角色', async () => {
    await render([{ id: 'old', providerId: 'api', modelId: 'fast', description: 'old' }]);
    await pick(0, 'fast');
    await pick(2, 'smart');
    await pick(4, 'fast');
    await clickEl(slot(roles()[4], 'tune'));
    expect(slot(roles()[4], 'editor')).not.toBeNull();
    await clickEl(slot(roles()[4], 'skip'));
    expect(slot(roles()[4], 'editor')).toBeNull();
    expect(slot(roles()[4], 'tune')).toBeNull();
    // 重新选中时编辑区不会自己冒出来
    await pick(4, 'fast');
    expect(slot(roles()[4], 'editor')).toBeNull();
    await clickEl(slot(roles()[4], 'skip'));

    expect(footer().textContent).toContain('Will add 2 models (skipping 3 roles)');
    await act(async () => confirmButton()?.click());
    const written = harness.setEntries.mock.calls[0][0] as SubagentModelEntry[];
    expect(written.map((e) => [e.modelId, e.description])).toEqual([
      ['fast', 'old'],
      ['fast', SUBAGENT_ROLE_PRESETS[0].template],
      ['smart', SUBAGENT_ROLE_PRESETS[2].template],
    ]);
  });
});
