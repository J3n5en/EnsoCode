import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_SECRETARY_KEY } from '@/lib/secretarySettingsLink';
import { ContactsSettings } from './ContactsSettings';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/secretary/SecretaryContactPanel', () => ({
  SecretaryContactPanel: ({ secretaryId }: { secretaryId?: string }) => (
    <div data-panel-secretary={secretaryId ?? ''} />
  ),
}));

let root: Root;
let container: HTMLElement;
const store = new Map<string, string>();

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
  Object.assign(dom.window, {
    electronAPI: {
      secretary: {
        list: async () => [
          { id: 's1', name: 'A' },
          { id: 's2', name: 'B' },
        ],
        onListChanged: () => () => {},
      },
    },
  });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const panelSecretary = () =>
  container.querySelector('[data-panel-secretary]')?.getAttribute('data-panel-secretary');

describe('设置 → 联系方式与主人', () => {
  it('多秘书时编辑设置里选中的那个秘书，切换后跟着换并记住', async () => {
    store.set(SETTINGS_SECRETARY_KEY, 's2');
    await act(async () => root.render(<ContactsSettings />));
    expect(panelSecretary()).toBe('s2');
    const pick = container.querySelector('[data-secretary-id="s1"]') as HTMLElement;
    await act(async () => pick.click());
    expect(panelSecretary()).toBe('s1');
    expect(store.get(SETTINGS_SECRETARY_KEY)).toBe('s1');
  });
});
