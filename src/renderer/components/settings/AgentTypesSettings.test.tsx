import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTypeEditDialog, AgentTypeList } from './AgentTypesSettings';

const harness = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  pickerProps: [] as Record<string, unknown>[],
  addAgentType: vi.fn(),
  updateAgentType: vi.fn(),
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(harness.state),
}));
vi.mock('@/stores/modelDirectory/useProviders', () => ({
  useMaterializedProviders: () => harness.state.providers,
  useUsableProviders: () => harness.state.providers,
}));
vi.mock('@/components/chat/ModelPicker', () => ({
  MODEL_PICKER_FORM_TRIGGER_CLASS: 'form-trigger',
  ModelPicker: (props: Record<string, unknown>) => {
    harness.pickerProps.push(props);
    return (
      <div data-testid="model-picker">
        <button
          type="button"
          data-testid="pick-virtual"
          onClick={() => (props.onSelect as (p: string, m: string) => void)('enso-virtual', 'auto')}
        />
      </div>
    );
  },
}));
vi.mock('@/components/ui/dialog', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Wrap,
    DialogContent: Wrap,
    DialogHeader: Wrap,
    DialogTitle: Wrap,
    DialogPanel: Wrap,
    DialogFooter: Wrap,
  };
});
vi.mock('@/components/ui/select', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: Wrap,
    SelectTrigger: Wrap,
    SelectValue: () => null,
    SelectPopup: Wrap,
    SelectItem: Wrap,
  };
});
vi.mock('@/components/ui/switch', () => ({
  Switch: () => <button type="button" data-switch="off" />,
}));
vi.mock('./PresetsSettings', () => ({
  PickList: () => null,
  DetailRows: () => null,
  setFilteredIds: (list: string[]) => list,
}));

const VIRTUAL_ENTRY = {
  id: 'auto',
  name: 'Auto',
  enabled: true,
  primary: { providerId: 'p1', modelId: 'strong' },
  fallbacks: [],
};

const FIXED_VIRTUAL_TYPE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'deep-scout',
  description: 'Deep scout',
  systemPrompt: 'Be thorough.',
  tools: 'readonly' as const,
  modelMode: 'fixed' as const,
  providerId: 'enso-virtual',
  modelId: 'auto',
};

beforeEach(() => {
  harness.pickerProps = [];
  harness.addAgentType.mockClear();
  harness.updateAgentType.mockClear();
  harness.state = {
    providers: [
      {
        id: 'p1',
        name: 'p1',
        enabled: true,
        api: 'anthropic-messages',
        models: [{ id: 'strong' }],
      },
    ],
    agentTypes: [FIXED_VIRTUAL_TYPE],
    virtualModels: [VIRTUAL_ENTRY],
    disabledBuiltinAgentTypes: [],
    skills: [],
    mcpServers: [],
    subagentModelsEnabled: true,
    subagentModels: [{ id: 'm1', providerId: 'p1', modelId: 'strong', description: 'x' }],
    addAgentType: harness.addAgentType,
    updateAgentType: harness.updateAgentType,
    removeAgentType: vi.fn(),
    toggleBuiltinAgentType: vi.fn(),
  };
});

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('AgentTypeEditDialog 固定模型走统一选择器', () => {
  it('虚拟绑定原样交给 ModelPicker，并带虚拟模型清单', () => {
    renderToStaticMarkup(<AgentTypeEditDialog entry={FIXED_VIRTUAL_TYPE} onClose={() => {}} />);
    const picker = harness.pickerProps.find((props) => props.providerId === 'enso-virtual');
    expect(picker).toBeDefined();
    expect(picker?.modelId).toBe('auto');
    expect(picker?.virtualModels).toEqual([VIRTUAL_ENTRY]);
    // 跟随态不写推理覆盖，交给模型自身能力
    expect(picker?.modelCapabilityOverrides).toEqual({});
  });

  it('已有档位的条目把档位作为可编辑覆盖传给 ModelPicker', () => {
    renderToStaticMarkup(
      <AgentTypeEditDialog
        entry={{ ...FIXED_VIRTUAL_TYPE, reasoning: 'on', thinkingLevel: 'high' }}
        onClose={() => {}}
      />
    );
    const picker = harness.pickerProps.find((props) => props.providerId === 'enso-virtual');
    expect(picker?.modelCapabilityOverrides).toEqual({ reasoning: 'on', thinkingLevel: 'high' });
  });

  it('选中虚拟条目后保存，条目保持虚拟引用', async () => {
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = dom.document.getElementById('root');
    if (!container) throw new Error('Missing test root');
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <AgentTypeEditDialog
          entry={{ ...FIXED_VIRTUAL_TYPE, providerId: 'p1', modelId: 'strong' }}
          onClose={() => {}}
        />
      )
    );
    const pick = container.querySelector(
      '[data-testid="pick-virtual"]'
    ) as unknown as HTMLButtonElement | null;
    expect(pick).not.toBeNull();
    await act(async () => pick?.click());
    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save'
    );
    expect(save).toBeDefined();
    await act(async () => save?.click());
    expect(harness.updateAgentType).toHaveBeenCalledTimes(1);
    expect(harness.updateAgentType.mock.calls[0]?.[1]).toMatchObject({
      modelMode: 'fixed',
      providerId: 'enso-virtual',
      modelId: 'auto',
    });
  });
});

describe('AgentTypeList 展示', () => {
  it('固定虚拟绑定的行显示虚拟条目名', () => {
    const markup = renderToStaticMarkup(<AgentTypeList hasSubagentModels />);
    expect(markup).toContain('Auto');
    expect(markup).not.toContain('enso-virtual / auto');
  });
});
