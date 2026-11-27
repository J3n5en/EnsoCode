import type { ModelProvider } from '@shared/types';
import type { VirtualModelEntry } from '@shared/virtualModels';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      { id: 'spare', label: 'Spare', enabled: true },
    ],
  },
];

const VIRTUAL: VirtualModelEntry = {
  id: 'auto',
  name: 'Auto',
  enabled: true,
  primary: { providerId: 'api', modelId: 'smart' },
  fallbacks: [
    { providerId: 'api', modelId: 'fast' },
    { providerId: 'api', modelId: 'spare' },
  ],
};

/** 成员选择是弹层，这里按 option 扁平渲染，只关心排序按钮 */
vi.mock('@/components/chat/ModelPicker', () => ({
  MODEL_PICKER_DIALOG_TRIGGER_CLASS: 'form-trigger',
  MODEL_PICKER_FORM_TRIGGER_CLASS: 'form-trigger',
  ModelPicker: ({ modelId }: { modelId: string }) => <span data-member={modelId} />,
}));

vi.mock('@/stores/modelDirectory/useProviders', () => ({
  useUsableProviders: () => PROVIDERS,
  useUsableClassifierProviders: () => PROVIDERS,
}));

vi.mock('@/i18n', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useI18n: () => ({ t: (key: string) => key, language: 'en' }),
}));

let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  const api = (path = 'electronAPI'): unknown =>
    new Proxy(
      () =>
        Promise.resolve(
          path === 'electronAPI.sourceAuthority.read' ? { projects: [], conversations: [] } : null
        ),
      { get: (_t, key) => (key === 'then' ? undefined : api(`${path}.${String(key)}`)) }
    );
  Object.assign(dom.window, {
    electronAPI: api(),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('navigator', { language: 'en-US', platform: 'MacIntel', userAgent: 'node' });
  vi.stubGlobal(
    'localStorage',
    dom.window.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} }
  );
  for (const name of [
    'HTMLElement',
    'Element',
    'Node',
    'HTMLInputElement',
    'Event',
    'CustomEvent',
    'getComputedStyle',
  ] as const) {
    const value = (dom as unknown as Record<string, unknown>)[name];
    if (value) vi.stubGlobal(name, value);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  );
  const { useSettingsStore } = await import('@/stores/settings');
  useSettingsStore.setState({ providers: PROVIDERS, virtualModels: [VIRTUAL] });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

const order = async () => {
  const { useSettingsStore } = await import('@/stores/settings');
  return useSettingsStore.getState().virtualModels[0]?.fallbacks.map((ref) => ref.modelId);
};

const arrows = (label: string) =>
  [...container.querySelectorAll(`button[aria-label="${label}"]`)] as HTMLButtonElement[];

/** 点完等 store 的异步落盘跑完，避免 act 警告 */
const click = async (button: HTMLButtonElement | undefined) => {
  await act(async () => button?.click());
  await act(async () => undefined);
};

describe('备用模型的排序按钮', () => {
  it('点下移把第一项换到第二项，末项的下移不可用', async () => {
    const { VirtualModelsSettings } = await import('./VirtualModelsSettings');
    await act(async () => root.render(<VirtualModelsSettings />));
    expect(await order()).toEqual(['fast', 'spare']);

    const down = arrows('Move down');
    expect(down).toHaveLength(2);
    expect(down[1]?.disabled).toBe(true);
    await click(down[0]);
    expect(await order()).toEqual(['spare', 'fast']);

    const up = arrows('Move up');
    expect(up[0]?.disabled).toBe(true);
    await click(up[1]);
    expect(await order()).toEqual(['fast', 'spare']);
  });

  it('只有一个备用模型时不显示排序按钮', async () => {
    const { useSettingsStore } = await import('@/stores/settings');
    useSettingsStore.setState({
      virtualModels: [{ ...VIRTUAL, fallbacks: [{ providerId: 'api', modelId: 'fast' }] }],
    });
    const { VirtualModelsSettings } = await import('./VirtualModelsSettings');
    await act(async () => root.render(<VirtualModelsSettings />));
    expect(arrows('Move up')).toHaveLength(0);
    expect(arrows('Move down')).toHaveLength(0);
  });
});
