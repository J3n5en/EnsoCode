import type { SecretaryContactState } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '') : key,
  }),
}));
vi.mock('@/plugins/PluginIcon', () => ({ PluginIcon: () => null }));
vi.mock('@/plugins/PluginView', () => ({ PluginFrame: () => null }));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => '' } }));
vi.mock('@/components/ui/switch', () => ({ Switch: () => null }));

const { SecretaryContactPanel } = await import('./SecretaryContactPanel');

function contactState(groups: SecretaryContactState['telegram']['groups']): SecretaryContactState {
  const caps = {
    buttons: true,
    urlButtons: true,
    edit: true,
    typing: true,
    format: 'html' as const,
    maxChars: 4096,
    commandMenu: true,
    images: true,
    files: true,
  };
  return {
    enabled: true,
    channels: [
      {
        id: 'telegram',
        title: 'Telegram',
        builtin: true,
        status: 'connected',
        caps,
        prefs: { enabled: true, push: true, cardConfirm: true, syncMirror: false, memory: false },
      },
    ],
    telegram: {
      status: 'bound',
      chat: { id: 777, username: 'j3n5en' },
      bot: { id: 42, username: 'enso_bot', name: 'Enso' },
      allowCardConfirm: true,
      allowMemory: false,
      syncMirror: false,
      groups,
      following: [],
      poll: { state: 'running' },
      secure: true,
    },
  };
}

let root: Root;
let container: HTMLElement;
let state: SecretaryContactState;
let contactSettings: ReturnType<typeof vi.fn>;

const groupsBox = () => container.querySelector('[data-enso="secretary-contact-groups"]');
const addButton = () =>
  container.querySelector('[data-enso="secretary-contact-group-add"]') as HTMLButtonElement;

async function render(): Promise<void> {
  await act(async () => {
    root.render(<SecretaryContactPanel />);
  });
}

async function typeAndAdd(value: string): Promise<void> {
  const input = container.querySelector(
    '[data-enso="secretary-contact-group-input"]'
  ) as HTMLInputElement;
  await act(async () => {
    // linkedom 里 React 收不到 input 事件：直接调节点上的 onChange
    const key = Object.keys(input).find((name) => name.startsWith('__reactProps'));
    const props = (key ? (input as unknown as Record<string, unknown>)[key] : null) as {
      onChange?: (event: { target: { value: string } }) => void;
    } | null;
    props?.onChange?.({ target: { value } });
  });
  await act(async () => {
    input.closest('form')?.dispatchEvent(new window.Event('submit', { bubbles: true }));
  });
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state = contactState([]);
  contactSettings = vi.fn(async () => ({ ok: true }));
  (dom.window as unknown as Record<string, unknown>).electronAPI = {
    secretary: {
      contactState: vi.fn(async () => state),
      onContactChanged: vi.fn(() => () => {}),
      contactSettings,
    },
    extensionPlugins: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => {}) },
  };
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('Telegram 群白名单', () => {
  it('空名单：说明只认绑定账号，并提示群消息一律不收', async () => {
    await render();
    const text = groupsBox()?.textContent ?? '';
    expect(text).toContain('only messages from the bound account count');
    expect(text).toContain('No groups yet: group messages are not received.');
    expect(addButton().disabled).toBe(true);
  });

  it('见过的群显示标题与 id，没见过只显示 id', async () => {
    state = contactState([{ id: '-1001', title: 'Dev 群' }, { id: '-1002' }]);
    await render();
    const rows = [...container.querySelectorAll('[data-enso="secretary-contact-group"]')];
    expect(rows.map((row) => row.textContent?.trim())).toEqual(['Dev 群 -1001', '-1002']);
  });

  it('添加做 trim，空白与重复的不发；删除带原 id', async () => {
    state = contactState([{ id: '-1001' }]);
    await render();
    await typeAndAdd('   ');
    await typeAndAdd(' -1001 ');
    expect(contactSettings).not.toHaveBeenCalled();
    await typeAndAdd('  -1002  ');
    expect(contactSettings).toHaveBeenCalledWith({
      telegramGroup: { action: 'add', chatId: '-1002' },
    });
    const remove = container.querySelector(
      '[data-enso="secretary-contact-group-remove"]'
    ) as HTMLButtonElement;
    await act(async () => {
      remove.click();
    });
    expect(contactSettings).toHaveBeenLastCalledWith({
      telegramGroup: { action: 'remove', chatId: '-1001' },
    });
  });
});
