import { EventEmitter } from 'node:events';
import type { MainToPluginHost } from '@shared/extensionPlugins/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProcess, type PluginProcessDeps } from './process';

class FakeChild extends EventEmitter {
  pid = 1;
  inbox: MainToPluginHost[] = [];
  killed = false;
  postMessage(message: MainToPluginHost) {
    this.inbox.push(message);
  }
  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
  reply(message: unknown) {
    this.emit('message', message);
  }
}

const registered = { tools: ['lookup'], commands: [], triggers: [], rendererMethods: [] };

function setup(patch: Partial<PluginProcessDeps> = {}) {
  const children: FakeChild[] = [];
  const onExit = vi.fn();
  const proc = new PluginProcess({
    fork: () => {
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child as never;
    },
    hostPath: '/tmp/plugin-host.js',
    env: {},
    init: { pluginId: 'a.b', pluginRoot: '/p', main: 'main.js', dataDir: '/d' },
    handleHostCall: async () => 'host-value',
    onExit,
    idleMs: 1000,
    readyTimeoutMs: 500,
    ...patch,
  });
  const child = () => {
    const c = children.at(-1);
    if (!c) throw new Error('no child');
    return c;
  };
  return { proc, children, child, onExit };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function readyProcess(s: ReturnType<typeof setup>) {
  const ready = s.proc.ready();
  await flush();
  s.child().reply({ t: 'ready', registered });
  return ready;
}

describe('PluginProcess', () => {
  it('按需拉起，spawn 后发送 init，收到 ready 后返回注册表', async () => {
    const s = setup();
    expect(s.children).toHaveLength(0);
    expect(await readyProcess(s)).toEqual(registered);
    expect(s.child().inbox[0]).toMatchObject({ t: 'init', pluginId: 'a.b' });
  });

  it('init-error 时 ready 失败', async () => {
    const s = setup();
    const ready = s.proc.ready();
    await flush();
    s.child().reply({ t: 'init-error', message: 'boom' });
    await expect(ready).rejects.toMatchObject({ code: 'PLUGIN_INIT_FAILED' });
  });

  it('调用往返，并把插件的宿主调用交给 Main 处理', async () => {
    const handleHostCall = vi.fn(async () => 'host-value');
    const s = setup({ handleHostCall });
    await readyProcess(s);
    const result = s.proc.call(
      'tool.execute',
      { name: 'lookup' },
      { invocationId: 'i1', sessionId: 's1', projectRoot: null, timeoutMs: 1000 }
    );
    await flush();
    const sentCall = s.child().inbox.find((m) => m.t === 'call');
    if (sentCall?.t !== 'call') throw new Error('no call');
    s.child().reply({
      t: 'call',
      id: 'h1',
      api: 'fs.readText',
      args: { path: 'a' },
      invocationId: 'i1',
    });
    await flush();
    expect(handleHostCall).toHaveBeenCalledWith('fs.readText', { path: 'a' }, 'i1');
    expect(s.child().inbox).toContainEqual({ t: 'res', id: 'h1', ok: true, value: 'host-value' });
    s.child().reply({ t: 'res', id: sentCall.id, ok: true, value: { content: 'ok' } });
    await expect(result).resolves.toEqual({ content: 'ok' });
  });

  it('插件日志交给 onLog，级别不合法按 info', async () => {
    const onLog = vi.fn();
    const s = setup({ onLog });
    await readyProcess(s);
    s.child().reply({ t: 'log', level: 'error', message: 'boom' });
    s.child().reply({ t: 'log', level: 'nope', message: 'x' });
    s.child().reply({ t: 'log', level: 'info', message: 42 });
    expect(onLog.mock.calls).toEqual([
      ['error', 'boom'],
      ['info', 'x'],
    ]);
  });

  it('未知宿主接口直接拒绝，不交给 Main', async () => {
    const handleHostCall = vi.fn(async () => 'host-value');
    const s = setup({ handleHostCall });
    await readyProcess(s);
    s.child().reply({ t: 'call', id: 'h2', api: 'session.messages', args: {} });
    await flush();
    expect(handleHostCall).not.toHaveBeenCalled();
    expect(s.child().inbox).toContainEqual(
      expect.objectContaining({
        id: 'h2',
        ok: false,
        error: expect.objectContaining({ code: 'UNKNOWN_API' }),
      })
    );
  });

  it('超时：发送 cancel 并以 TIMEOUT 失败，晚到结果被丢弃', async () => {
    const s = setup();
    await readyProcess(s);
    const result = s.proc.call(
      'tool.execute',
      {},
      { invocationId: 'i2', sessionId: null, projectRoot: null, timeoutMs: 100 }
    );
    const assertion = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    expect(s.child().inbox).toContainEqual({ t: 'cancel', invocationId: 'i2' });
    const sentCall = s.child().inbox.find((m) => m.t === 'call');
    if (sentCall?.t === 'call')
      s.child().reply({ t: 'res', id: sentCall.id, ok: true, value: 'late' });
  });

  it('业务错误只失败本次调用', async () => {
    const s = setup();
    await readyProcess(s);
    const result = s.proc.call(
      'command.run',
      {},
      { invocationId: 'i3', sessionId: null, projectRoot: null, timeoutMs: 1000 }
    );
    await flush();
    const sentCall = s.child().inbox.find((m) => m.t === 'call');
    if (sentCall?.t === 'call')
      s.child().reply({
        t: 'res',
        id: sentCall.id,
        ok: false,
        error: { code: 'X', message: 'bad' },
      });
    await expect(result).rejects.toMatchObject({ code: 'X' });
    expect(s.onExit).not.toHaveBeenCalled();
  });

  it('非预期退出：挂起调用失败并上报 unexpected', async () => {
    const s = setup();
    await readyProcess(s);
    const result = s.proc.call(
      'tool.execute',
      {},
      { invocationId: 'i4', sessionId: null, projectRoot: null, timeoutMs: 1000 }
    );
    const assertion = expect(result).rejects.toMatchObject({ code: 'PLUGIN_EXITED' });
    await flush();
    s.child().emit('exit', 1);
    await assertion;
    expect(s.onExit).toHaveBeenCalledWith({ unexpected: true });
  });

  it('闲置超时正常退出，不算崩溃；下次调用重新拉起', async () => {
    const s = setup();
    await readyProcess(s);
    await vi.advanceTimersByTimeAsync(1100);
    expect(s.child().inbox).toContainEqual({ t: 'shutdown' });
    expect(s.children[0]?.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.children[0]?.killed).toBe(true);
    expect(s.onExit).toHaveBeenCalledWith({ unexpected: false });
    await readyProcess(s);
    expect(s.children).toHaveLength(2);
  });

  it('常驻进程不因空闲退出', async () => {
    const s = setup({ resident: true });
    await readyProcess(s);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.children[0]?.killed).toBe(false);
    expect(s.onExit).not.toHaveBeenCalled();
  });

  it('stop 先发 shutdown，进程自己退出就不再 kill', async () => {
    const s = setup();
    await readyProcess(s);
    const stopped = s.proc.whenStopped();
    expect(s.child().inbox).toContainEqual({ t: 'shutdown' });
    expect(s.child().killed).toBe(false);
    s.child().emit('exit', 0);
    await flush();
    await stopped;
    expect(s.child().killed).toBe(false);
    expect(s.onExit).toHaveBeenCalledWith({ unexpected: false });
  });

  it('ready 超时视为加载失败', async () => {
    const s = setup();
    const ready = s.proc.ready();
    const assertion = expect(ready).rejects.toMatchObject({ code: 'PLUGIN_INIT_FAILED' });
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
  });
});
