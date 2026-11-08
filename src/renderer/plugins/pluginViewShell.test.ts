import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { viewThemePush } from './viewBridge';

function bootShell() {
  const html = readFileSync(new URL('../public/plugin-view.html', import.meta.url), 'utf8');
  const script = html.match(/id="enso-view-bridge">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('找不到侧栏桥脚本');
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const documentElement = { dataset: {} as Record<string, string> };
  const parent = { postMessage() {} };
  const window = {
    parent,
    addEventListener(type: string, listener: (event: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  const document = {
    documentElement,
    open() {},
    write() {
      documentElement.dataset = {};
    },
    close() {},
  };
  const context = createContext({
    window,
    document,
    Object,
    Promise,
    Map,
    Set,
    Error,
    String,
  });
  runInContext(script, context);
  let portHandler: ((message: { data: unknown }) => void) | null = null;
  const port = {
    postMessage() {},
    set onmessage(handler: (message: { data: unknown }) => void) {
      portHandler = handler;
    },
  };
  for (const listener of listeners.get('message') ?? []) {
    listener({
      source: parent,
      data: { type: 'enso-view-init', theme: 'light', html: '<p>notes</p>', storage: {} },
      ports: [port],
    });
  }
  const enso = (window as unknown as { enso: ShellEnso }).enso;
  return {
    enso,
    dataset: documentElement.dataset,
    push(theme: 'light' | 'dark') {
      portHandler?.({ data: viewThemePush(theme) });
    },
    pushEvent(name: string, data: unknown) {
      portHandler?.({ data: { type: 'enso-view-event', name, data } });
    },
  };
}

interface ShellEnso {
  theme: string;
  onTheme(listener: (theme: string) => void): () => void;
  on(name: string, listener: (data: unknown) => void): () => void;
}

describe('侧栏页面主题', () => {
  it('打开后能订阅主题变化，并同步 data-theme', () => {
    const shell = bootShell();
    expect(shell.enso.theme).toBe('light');
    expect(shell.dataset.theme).toBe('light');
    const seen: string[] = [];
    const unsubscribe = shell.enso.onTheme((theme) => seen.push(theme));
    shell.enso.onTheme(() => {
      throw new Error('bad listener');
    });
    shell.push('dark');
    expect(seen).toEqual(['dark']);
    expect(shell.enso.theme).toBe('dark');
    expect(shell.dataset.theme).toBe('dark');
    shell.push('dark');
    expect(seen).toEqual(['dark']);
    unsubscribe();
    shell.push('light');
    expect(seen).toEqual(['dark']);
    expect(shell.enso.theme).toBe('light');
    expect(shell.dataset.theme).toBe('light');
    shell.push('dark');
    shell.push('light');
    expect(seen).toEqual(['dark']);
  });

  it('把主进程事件交给同名订阅', () => {
    const shell = bootShell();
    const seen: unknown[] = [];
    const unsubscribe = shell.enso.on('snapshot', (data) => seen.push(data));
    shell.enso.on('snapshot', () => {
      throw new Error('bad listener');
    });
    shell.pushEvent('other', { n: 0 });
    shell.pushEvent('snapshot', { n: 1 });
    expect(seen).toEqual([{ n: 1 }]);
    unsubscribe();
    shell.pushEvent('snapshot', { n: 2 });
    expect(seen).toEqual([{ n: 1 }]);
  });
});
