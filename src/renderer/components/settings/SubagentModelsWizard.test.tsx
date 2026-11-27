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

describe('SubagentModelsWizard', () => {
  it('五个角色默认全部留空显示「跳过此角色」，确认禁用', async () => {
    await render();
    expect(roles()).toHaveLength(5);
    expect(
      roles().map((role) =>
        role.querySelector('[data-model-picker]')?.getAttribute('data-model-picker')
      )
    ).toEqual(Array(5).fill('Skip this role'));
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('[data-slot="subagent-wizard-description-preview"]')).toBeNull();
    expect(footer().textContent).toContain('Will add 0 models (skipping 5 roles)');
    expect(confirmButton()?.disabled).toBe(true);
    expect(harness.segmented).toBe(false);
  });

  it('选中后只露一行描述预览，点「微调」才出现文本框', async () => {
    await render();
    await pick(1, 'smart');
    const worker = roles()[1];
    const template = SUBAGENT_ROLE_PRESETS[1].template;
    expect(
      worker.querySelector('[data-slot="subagent-wizard-description-preview"]')?.textContent
    ).toBe(template);
    expect(container.querySelector('textarea')).toBeNull();
    expect(roles()[0].querySelector('[data-slot="subagent-wizard-tune"]')).toBeNull();

    await act(async () =>
      (worker.querySelector('[data-slot="subagent-wizard-tune"]') as HTMLElement).click()
    );
    const textarea = roles()[1].querySelector('textarea');
    expect(textarea?.value).toBe(template);
    expect(roles()[1].querySelector('[data-slot="subagent-wizard-tune"]')?.textContent).toBe(
      'Done'
    );
    expect(footer().textContent).toContain('Will add 1 models (skipping 4 roles)');
  });

  it('清除按钮把角色改回跳过；确认只写入已选角色', async () => {
    await render([{ id: 'old', providerId: 'api', modelId: 'fast', description: 'old' }]);
    expect(harness.segmented).toBe(true);
    await pick(0, 'fast');
    await pick(2, 'smart');
    await pick(4, 'fast');
    await act(async () =>
      (roles()[4].querySelector('[aria-label="Skip this role"]') as HTMLElement).click()
    );
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
