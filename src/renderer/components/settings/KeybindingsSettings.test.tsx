import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginCommandRef } from '@/plugins/commands';
import { KeybindingsSettings } from './KeybindingsSettings';
import { findNestedBoxes } from './kit/boxes';

const harness = vi.hoisted(() => ({
  keybindings: {} as Record<string, string>,
  setKeybinding: vi.fn(),
  resetKeybinding: vi.fn(),
  commands: [] as PluginCommandRef[],
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars?.[name] ?? ''),
  }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: Record<string, unknown>) => unknown) =>
    select({
      keybindings: harness.keybindings,
      setKeybinding: harness.setKeybinding,
      resetKeybinding: harness.resetKeybinding,
    }),
}));
vi.mock('@/plugins/commands', () => ({ pluginCommandRefs: () => harness.commands }));

let root: Root;
let container: HTMLElement;
let win: typeof globalThis;

async function mount() {
  await act(async () => root.render(<KeybindingsSettings />));
}

/** 插件列表只在挂载时拉一次 */
async function remount() {
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount();
}

/** 含该标签文字的最小一行 */
function row(label: string): HTMLElement {
  const candidates = [...container.querySelectorAll('*')].filter(
    (el) => el.textContent?.includes(label) && el.querySelector('button')
  );
  const found = candidates.sort(
    (a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length
  )[0];
  expect(found, label).not.toBeUndefined();
  return found as HTMLElement;
}
const keyButton = (label: string) =>
  [...row(label).querySelectorAll('button')].find((b) => !b.getAttribute('title')) as HTMLElement;
const titled = (label: string, title: string) =>
  row(label).querySelector(`button[title="${title}"]`) as HTMLElement | null;

async function press(target: HTMLElement, init: { key: string; code?: string; altKey?: boolean }) {
  const event = new win.Event('keydown', { bubbles: true, cancelable: true });
  Object.assign(event, { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init });
  await act(async () => target.dispatchEvent(event));
}

beforeEach(async () => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  win = dom.window as unknown as typeof globalThis;
  Object.assign(dom.window, {
    electronAPI: {
      extensionPlugins: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => {}) },
    },
  });
  vi.clearAllMocks();
  harness.keybindings = {};
  harness.commands = [];
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await mount();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('KeybindingsSettings', () => {
  it('每个内置动作一行，带生效范围说明', () => {
    expect(container.textContent).toContain('Toggle sidebar');
    expect(container.textContent).toContain('Send message');
    expect(row('Switch model').textContent).toContain('Only when the chat input is focused');
    expect(container.querySelector('[data-settings-row="shortcuts.root"]')).not.toBeNull();
  });

  it('点击键位进入录制，按下组合键写入', async () => {
    const button = keyButton('Toggle sidebar');
    await act(async () => button.click());
    expect(row('Toggle sidebar').textContent).toContain('Press shortcut…');
    await press(keyButton('Toggle sidebar'), { key: 'q', code: 'KeyQ', altKey: true });
    expect(harness.setKeybinding).toHaveBeenCalledWith('toggle-sidebar', 'alt+q');
  });

  it('Esc 取消不写入，Backspace 清空', async () => {
    await act(async () => keyButton('Toggle sidebar').click());
    await press(keyButton('Toggle sidebar'), { key: 'Escape' });
    expect(harness.setKeybinding).not.toHaveBeenCalled();
    expect(row('Toggle sidebar').textContent).not.toContain('Press shortcut…');
    await act(async () => keyButton('Toggle sidebar').click());
    await press(keyButton('Toggle sidebar'), { key: 'Backspace' });
    expect(harness.setKeybinding).toHaveBeenCalledWith('toggle-sidebar', '');
  });

  it('与其它动作冲突时拒绝并指出占用方', async () => {
    harness.keybindings = { 'toggle-side-panel': 'alt+q' };
    await mount();
    await act(async () => keyButton('Toggle sidebar').click());
    await press(keyButton('Toggle sidebar'), { key: 'q', code: 'KeyQ', altKey: true });
    expect(harness.setKeybinding).not.toHaveBeenCalled();
    expect(row('Toggle sidebar').textContent).toContain('Already used by "Toggle side panel"');
  });

  it('自定义过的可以恢复默认，任何已绑定的可以移除', async () => {
    expect(titled('Toggle sidebar', 'Reset to default')).toBeNull();
    harness.keybindings = { 'toggle-sidebar': 'alt+q' };
    await mount();
    await act(async () => titled('Toggle sidebar', 'Reset to default')?.click());
    expect(harness.resetKeybinding).toHaveBeenCalledWith('toggle-sidebar');
    await act(async () => titled('Toggle sidebar', 'Remove shortcut')?.click());
    expect(harness.setKeybinding).toHaveBeenCalledWith('toggle-sidebar', '');
  });

  it('插件命令单独一组，默认键被内置占用时标出占用方', async () => {
    expect(container.textContent).not.toContain('Plugin commands');
    harness.keybindings = { 'toggle-sidebar': 'alt+q' };
    harness.commands = [
      { pluginId: 'p', pluginName: 'Demo plugin', id: 'run', title: 'Run demo', key: 'alt+q' },
    ];
    await remount();
    expect(container.textContent).toContain('Plugin commands');
    expect(row('Run demo').textContent).toContain('Demo plugin');
    expect(row('Run demo').textContent).toContain('Already used by "Toggle sidebar"');
  });

  it('页面里没有卡片套卡片', async () => {
    harness.commands = [{ pluginId: 'p', pluginName: 'Demo', id: 'run', title: 'Run demo' }];
    await remount();
    expect(container.textContent).toContain('Run demo');
    expect(findNestedBoxes(container)).toEqual([]);
  });
});
