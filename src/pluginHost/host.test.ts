import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MainToPluginHost, PluginHostToMain } from '@shared/extensionPlugins/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, createProcessTransport, type HostProcess, runPluginHost } from './host';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-host-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'main.mjs'), source);
  const sent: PluginHostToMain[] = [];
  let exited: number | null = null;
  let handler: (msg: unknown) => void = () => {};
  runPluginHost({
    send: (m) => sent.push(m),
    onMessage: (h) => (handler = h),
    exit: (code) => {
      exited = code;
    },
  });
  const deliver = (msg: MainToPluginHost) => handler(msg);
  const next = async (pred: (m: PluginHostToMain) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const found = sent.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('timeout');
  };
  deliver({ t: 'init', pluginId: 'a.b', pluginRoot: dir, main: 'main.mjs', dataDir: dir });
  return {
    dir,
    sent,
    deliver,
    next,
    exited: () => exited,
  };
}

const call = (
  id: string,
  method: 'tool.execute' | 'command.run' | 'renderer.call',
  payload: unknown
) =>
  ({
    t: 'call',
    id,
    method,
    payload,
    invocationId: `inv-${id}`,
    sessionId: 's1',
    projectRoot: '/repo',
  }) as const;

describe('runPluginHost', () => {
  it('加载后上报已注册的工具、命令、补全和渲染方法', async () => {
    const h = harness(`export function activate(enso) {
      enso.tools.register('lookup', async (args) => 'hi ' + args.q);
      enso.commands.register('refresh', async () => {});
      enso.triggers.register('demo', { candidates: async () => [], pick: async () => ({ text: 'x' }) });
      enso.renderer.handle('ping', async () => 'pong');
    }`);
    const ready = await h.next((m) => m.t === 'ready');
    expect(ready).toEqual({
      t: 'ready',
      registered: {
        tools: ['lookup'],
        commands: ['refresh'],
        triggers: ['demo'],
        rendererMethods: ['ping'],
        events: [],
        schedules: [],
        exports: [],
      },
    });
  });

  it('执行工具并把字符串结果规整成 { content }', async () => {
    const h = harness(
      `export function activate(enso) { enso.tools.register('lookup', async (args, ctx) => 'hi ' + args.q + ' ' + ctx.sessionId); }`
    );
    await h.next((m) => m.t === 'ready');
    h.deliver(call('1', 'tool.execute', { name: 'lookup', args: { q: 'x' } }));
    expect(await h.next((m) => m.t === 'res' && m.id === '1')).toEqual({
      t: 'res',
      id: '1',
      ok: true,
      value: { content: 'hi x s1' },
    });
  });

  it('activate 抛错时上报 init-error', async () => {
    const h = harness(`export function activate() { throw new Error('boom'); }`);
    expect(await h.next((m) => m.t === 'init-error')).toMatchObject({
      message: expect.stringContaining('boom'),
    });
    expect(await h.next((m) => m.t === 'log')).toMatchObject({
      level: 'error',
      message: expect.stringContaining('boom'),
    });
  });

  it('处理器抛错时把堆栈写进日志', async () => {
    const h = harness(`export function activate(enso) {
      enso.commands.register('bad', async () => { throw new Error('kaput'); });
    }`);
    await h.next((m) => m.t === 'ready');
    h.deliver(call('5', 'command.run', { id: 'bad' }));
    await h.next((m) => m.t === 'res' && m.id === '5');
    expect(await h.next((m) => m.t === 'log')).toMatchObject({
      level: 'error',
      message: expect.stringMatching(/command\.run[\s\S]*kaput/),
    });
  });

  it('未注册的处理器返回 NOT_FOUND', async () => {
    const h = harness('export function activate() {}');
    await h.next((m) => m.t === 'ready');
    h.deliver(call('2', 'command.run', { id: 'nope' }));
    expect(await h.next((m) => m.t === 'res' && m.id === '2')).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('处理器内的宿主调用自动带上本次调用 id，并转发回 Main', async () => {
    const h = harness(`export function activate(enso) {
      enso.renderer.handle('read', async () => enso.fs.readText('a.txt'));
    }`);
    await h.next((m) => m.t === 'ready');
    h.deliver(call('3', 'renderer.call', { method: 'read', args: null }));
    const hostCall = await h.next((m) => m.t === 'call');
    expect(hostCall).toMatchObject({
      api: 'fs.readText',
      args: { path: 'a.txt' },
      invocationId: 'inv-3',
    });
    if (hostCall.t !== 'call') return;
    h.deliver({ t: 'res', id: hostCall.id, ok: true, value: 'content' });
    expect(await h.next((m) => m.t === 'res' && m.id === '3')).toMatchObject({
      ok: true,
      value: 'content',
    });
  });

  it('取消后处理器收到 abort，挂起的宿主调用被拒绝', async () => {
    const h = harness(`export function activate(enso) {
      enso.tools.register('slow', async (args, ctx) => {
        try { await enso.fs.readText('a.txt'); return 'done'; }
        catch (e) { return 'aborted:' + ctx.signal.aborted; }
      });
    }`);
    await h.next((m) => m.t === 'ready');
    h.deliver(call('4', 'tool.execute', { name: 'slow', args: {} }));
    await h.next((m) => m.t === 'call');
    h.deliver({ t: 'cancel', invocationId: 'inv-4' });
    expect(await h.next((m) => m.t === 'res' && m.id === '4')).toMatchObject({
      ok: true,
      value: { content: 'aborted:true' },
    });
  });

  it('未声明的事件不能订阅', async () => {
    const h = harness(
      `export function activate(enso) { enso.events.on('session_start', () => {}); }`
    );
    expect(await h.next((m) => m.t === 'init-error')).toMatchObject({
      message: expect.stringContaining('清单未声明事件'),
    });
  });

  // Main（extensionPlugins/process.ts 的 SHUTDOWN_GRACE_MS）发出 shutdown 后 3 秒就 SIGTERM，且计时比宿主先开始；
  // 宿主截止若也是 3 秒，deactivate 卡住时总是先挨 SIGTERM，来不及 killTrackedChildren，插件子进程成孤儿
  it('shutdown 调用 deactivate，超时后赶在 Main 的 SIGTERM 之前杀掉子进程并退出', async () => {
    const MAIN_SHUTDOWN_GRACE_MS = 3_000;
    const h = harness(`import { spawn } from 'node:child_process';
      export function activate() {
        spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10000); setInterval(() => {}, 1000)']);
      }
      export function deactivate() { return new Promise(() => {}); }
    `);
    await h.next((m) => m.t === 'ready');
    vi.useFakeTimers();
    try {
      h.deliver({ t: 'shutdown' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.exited()).toBeNull();
      // 至少留出几百毫秒给 IPC 延迟与收子进程
      await vi.advanceTimersByTimeAsync(MAIN_SHUTDOWN_GRACE_MS - 2_000 - 300);
      expect(h.exited()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('子进程收敛', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  it.each([
    ['具名导入', `import { spawn } from 'node:child_process';`, 'spawn'],
    ['命名空间导入', `import * as cp from 'node:child_process';`, 'cp.spawn'],
    ['默认导入', `import cp from 'node:child_process';`, 'cp.spawn'],
    ['不带 node: 前缀', `import { spawn } from 'child_process';`, 'spawn'],
  ])('%s拉起的子进程在 shutdown 后退出', async (_label, importLine, spawnCall) => {
    const h = harness(`${importLine}
      export function activate(enso) {
        const child = ${spawnCall}(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
        enso.tools.register('pid', () => String(child.pid));
      }`);
    await h.next((m) => m.t === 'ready');
    h.deliver(call('c1', 'tool.execute', { name: 'pid', args: {} }));
    const res = await h.next((m) => m.t === 'res' && m.id === 'c1');
    const pid = Number((res as { value: { content: string } }).value.content);
    expect(alive(pid)).toBe(true);
    h.deliver({ t: 'shutdown' });
    await h.next(() => h.exited() !== null);
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 10));
    expect(alive(pid)).toBe(false);
  });
});

describe('createProcessTransport', () => {
  /** 两种真实宿主进程的替身：桌面 utilityProcess 经 parentPort 收 { data }，服务端 child_process 经 IPC 收原始消息 */
  function fakeProcess(kind: 'parentPort' | 'ipc') {
    const sent: PluginHostToMain[] = [];
    const inbox = new EventEmitter();
    const exit = vi.fn();
    const proc: HostProcess =
      kind === 'parentPort'
        ? {
            parentPort: Object.assign(inbox, {
              postMessage: (m: unknown) => sent.push(m as PluginHostToMain),
            }),
            on: () => undefined,
            exit,
          }
        : {
            send: (m) => sent.push(m as PluginHostToMain),
            on: (_event, listener) => inbox.on('message', listener),
            exit,
          };
    const deliver = (msg: MainToPluginHost) =>
      inbox.emit('message', kind === 'parentPort' ? { data: msg } : msg);
    return { proc, sent, deliver, exit };
  }

  // 真实问题：index.ts 构造 transport 时没传 exit，宿主收到 shutdown 后不退出，
  // Main 每次停进程都等满 3 秒再 SIGTERM，期间新旧进程重叠
  it.each([
    ['桌面 utilityProcess', 'parentPort'],
    ['服务端 child_process', 'ipc'],
  ] as const)('%s：收到 shutdown 后宿主自己退出', async (_label, kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-host-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'main.mjs'), 'export function activate() {}');
    const { proc, sent, deliver, exit } = fakeProcess(kind);
    runPluginHost(createProcessTransport(proc));
    deliver({ t: 'init', pluginId: 'a.b', pluginRoot: dir, main: 'main.mjs', dataDir: dir });
    for (let i = 0; i < 200 && !sent.some((m) => m.t === 'ready'); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(sent.some((m) => m.t === 'ready')).toBe(true);
    deliver({ t: 'shutdown' });
    await new Promise((r) => setTimeout(r, 50));
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('captureConsole', () => {
  it('console 输出按级别转成日志消息', () => {
    const sent: PluginHostToMain[] = [];
    const noop = (..._args: unknown[]) => {};
    const target = { log: noop, info: noop, warn: noop, error: noop, debug: noop };
    captureConsole(target, (m) => sent.push(m));
    target.log('a', 1, { b: 2 });
    target.warn('w');
    target.error(new Error('e'));
    expect(sent[0]).toEqual({ t: 'log', level: 'info', message: 'a 1 {"b":2}' });
    expect(sent[1]).toEqual({ t: 'log', level: 'warn', message: 'w' });
    expect(sent[2]).toMatchObject({
      t: 'log',
      level: 'error',
      message: expect.stringContaining('Error: e'),
    });
  });
});
