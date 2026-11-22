import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { viewSessionPush, viewThemePush } from './viewBridge';

function bootShell(
  file?: { rel: string; text: string },
  session?: { sessionId: string | null; projectId: string | null }
) {
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
  const posted: unknown[] = [];
  const port = {
    postMessage(data: unknown) {
      posted.push(data);
    },
    set onmessage(handler: (message: { data: unknown }) => void) {
      portHandler = handler;
    },
  };
  for (const listener of listeners.get('message') ?? []) {
    listener({
      source: parent,
      data: {
        type: 'enso-view-init',
        theme: 'light',
        html: '<p>notes</p>',
        storage: {},
        ...(file ? { file } : {}),
        ...(session ? { session: viewSessionPush(session.sessionId, session.projectId) } : {}),
      },
      ports: [port],
    });
  }
  const enso = (window as unknown as { enso: ShellEnso }).enso;
  return {
    enso,
    dataset: documentElement.dataset,
    posted,
    push(theme: 'light' | 'dark') {
      portHandler?.({ data: viewThemePush(theme) });
    },
    pushEvent(name: string, data: unknown) {
      portHandler?.({ data: { type: 'enso-view-event', name, data } });
    },
    pushFile(rel: string, text: string) {
      portHandler?.({ data: { type: 'enso-file', rel, text } });
    },
    pushSession(sessionId: string | null, projectId: string | null) {
      portHandler?.({ data: viewSessionPush(sessionId, projectId) });
    },
  };
}

interface ShellEnso {
  theme: string;
  session: null | { sessionId: string | null; projectId: string | null };
  onSession(
    listener: (session: { sessionId: string | null; projectId: string | null }) => void
  ): () => void;
  onTheme(listener: (theme: string) => void): () => void;
  on(name: string, listener: (data: unknown) => void): () => void;
  file: null | {
    rel: string;
    text: string;
    onChange(listener: (file: { rel: string; text: string }) => void): () => void;
    update(text: string): void;
  };
}

describe('当前会话', () => {
  it('初始化带会话；全局页面换会话时收到推送，不变不回调', () => {
    const shell = bootShell(undefined, { sessionId: 's1', projectId: 'p1' });
    expect(shell.enso.session).toEqual({ sessionId: 's1', projectId: 'p1' });
    const seen: unknown[] = [];
    const off = shell.enso.onSession((next) => seen.push(next));
    shell.enso.onSession(() => {
      throw new Error('bad listener');
    });
    shell.pushSession('s1', 'p1');
    expect(seen).toEqual([]);
    shell.pushSession('s2', 'p2');
    expect(seen).toEqual([{ sessionId: 's2', projectId: 'p2' }]);
    expect(shell.enso.session).toEqual({ sessionId: 's2', projectId: 'p2' });
    shell.pushSession(null, null);
    expect(shell.enso.session).toBeNull();
    off();
    shell.pushSession('s3', 'p1');
    expect(seen).toHaveLength(2);
  });

  it('宿主没带会话时为 null', () => {
    expect(bootShell().enso.session).toBeNull();
  });
});

describe('文件查看器', () => {
  it('侧栏页面没有 enso.file', () => {
    expect(bootShell().enso.file).toBeNull();
  });

  it('拿到初始文件，收宿主推送，编辑回传且不回调自己', () => {
    const shell = bootShell({ rel: 'a.csv', text: 'x' });
    const file = shell.enso.file;
    if (!file) throw new Error('缺少 enso.file');
    expect([file.rel, file.text]).toEqual(['a.csv', 'x']);
    const seen: unknown[] = [];
    const off = file.onChange((next) => seen.push(next));
    file.update('y');
    expect(file.text).toBe('y');
    expect(shell.posted).toContainEqual({ type: 'enso-file-edit', text: 'y' });
    expect(seen).toEqual([]);
    shell.pushFile('a.csv', 'z');
    expect(file.text).toBe('z');
    expect(seen).toEqual([{ rel: 'a.csv', text: 'z' }]);
    off();
    shell.pushFile('a.csv', 'w');
    expect(seen).toHaveLength(1);
  });
});

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
