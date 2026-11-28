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

  it('contact.call 的 sendImage / sendFile：base64 还原成 Buffer 交给渠道；没实现报 UNSUPPORTED', async () => {
    const h = harness(`export function activate(enso) {
      void enso.contact.register('wechat', {
        caps: {},
        sendText: async () => ({}),
        sendImage: async (peerId, media) => ({
          messageId: [peerId, media.fileName, Buffer.isBuffer(media.data), [...media.data].join('.'), media.mimeType, media.caption].join('|'),
        }),
      });
    }`);
    const register = await h.next((m) => m.t === 'call' && m.api === 'contact.register');
    if (register.t !== 'call') return;
    h.deliver({ t: 'res', id: register.id, ok: true, value: null });
    await h.next((m) => m.t === 'ready');
    const contactCall = (id: string, payload: unknown) =>
      ({
        t: 'call',
        id,
        method: 'contact.call',
        payload,
        invocationId: `inv-${id}`,
        sessionId: null,
        projectRoot: null,
      }) as unknown as MainToPluginHost;
    await new Promise((r) => setTimeout(r, 10));
    h.deliver(
      contactCall('c1', {
        channelId: 'wechat',
        op: 'sendImage',
        peerId: 'wx-me',
        data: Buffer.from([1, 2, 3]).toString('base64'),
        fileName: 'a.png',
        mimeType: 'image/png',
        caption: '截图',
      })
    );
    expect(await h.next((m) => m.t === 'res' && m.id === 'c1')).toMatchObject({
      ok: true,
      value: { messageId: 'wx-me|a.png|true|1.2.3|image/png|截图' },
    });
    h.deliver(
      contactCall('c2', {
        channelId: 'wechat',
        op: 'sendFile',
        peerId: 'wx-me',
        data: '',
        fileName: 'b.zip',
      })
    );
    expect(await h.next((m) => m.t === 'res' && m.id === 'c2')).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED' },
    });
  });

  it('contact.call 抛出带 code 与 userMessage 的结构化错误时原样透传；普通 Error 向后兼容', async () => {
    const h = harness(`export function activate(enso) {
      void enso.contact.register('wechat', {
        caps: {},
        sendText: async (_peerId, msg) => {
          if (msg.text === 'structured') {
            throw Object.assign(new Error('sendmessage ret=-2 prepare failed'), {
              code: 'SESSION_EXPIRED',
              userMessage: '微信会话已过期，请在微信里给机器人发任意一条消息',
            });
          }
          throw new Error('legacy failure');
        },
      });
    }`);
    const register = await h.next((m) => m.t === 'call' && m.api === 'contact.register');
    if (register.t !== 'call') return;
    h.deliver({ t: 'res', id: register.id, ok: true, value: null });
    await h.next((m) => m.t === 'ready');
    const contactCall = (id: string, text: string) =>
      ({
        t: 'call',
        id,
        method: 'contact.call',
        payload: { channelId: 'wechat', op: 'sendText', peerId: 'wx-me', text },
        invocationId: `inv-${id}`,
        sessionId: null,
        projectRoot: null,
      }) as unknown as MainToPluginHost;
    await new Promise((r) => setTimeout(r, 10));
    h.deliver(contactCall('e1', 'structured'));
    expect(await h.next((m) => m.t === 'res' && m.id === 'e1')).toEqual({
      t: 'res',
      id: 'e1',
      ok: false,
      error: {
        code: 'SESSION_EXPIRED',
        message: 'sendmessage ret=-2 prepare failed',
        userMessage: '微信会话已过期，请在微信里给机器人发任意一条消息',
      },
    });
    h.deliver(contactCall('e2', 'legacy'));
    expect(await h.next((m) => m.t === 'res' && m.id === 'e2')).toEqual({
      t: 'res',
      id: 'e2',
      ok: false,
      error: {
        code: 'PLUGIN_ERROR',
        message: 'legacy failure',
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

  it('调用被取消记 debug；插件标了 expected 的业务错误记 info 且原样回传；其余照旧记 error', async () => {
    const h = harness(`export function activate(enso) {
      enso.commands.register('wait', (ctx) => new Promise((_, reject) => {
        ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }));
      enso.commands.register('coded', async () => { throw Object.assign(new Error('调用已取消'), { code: 'ABORTED' }); });
      enso.commands.register('origin', async () => {
        throw Object.assign(new Error('当前项目的 origin 不是 GitHub 仓库'), { code: 'NOT_GITHUB', expected: true });
      });
      enso.commands.register('bad', async () => { throw new Error('kaput'); });
    }`);
    await h.next((m) => m.t === 'ready');
    const logOf = async (id: string) => {
      await h.next((m) => m.t === 'res' && m.id === id);
      return h.sent.filter((m) => m.t === 'log').at(-1);
    };
    h.deliver(call('c1', 'command.run', { id: 'wait' }));
    await new Promise((r) => setTimeout(r, 10));
    h.deliver({ t: 'cancel', invocationId: 'inv-c1' });
    expect(await logOf('c1')).toMatchObject({ level: 'debug' });
    h.deliver(call('c2', 'command.run', { id: 'coded' }));
    expect(await logOf('c2')).toMatchObject({ level: 'debug' });
    h.deliver(call('c3', 'command.run', { id: 'origin' }));
    expect(await logOf('c3')).toMatchObject({
      level: 'info',
      message: expect.stringContaining('origin 不是 GitHub'),
    });
    expect(h.sent.find((m) => m.t === 'res' && m.id === 'c3')).toMatchObject({
      ok: false,
      error: { code: 'NOT_GITHUB', expected: true },
    });
    h.deliver(call('c4', 'command.run', { id: 'bad' }));
    expect(await logOf('c4')).toMatchObject({ level: 'error' });
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

  it('session.onTurnEnd：首个监听开订阅、回合结束回调、全部取消后关订阅', async () => {
    const h = harness(`const seen = []; let offs = [];
    export function activate(enso) {
      offs.push(enso.session.onTurnEnd((e) => seen.push('a:' + e.sessionId)));
      offs.push(enso.session.onTurnEnd(() => { throw new Error('listener boom'); }));
      enso.tools.register('seen', async () => seen.join(','));
      enso.tools.register('off', async () => { offs.forEach((off) => off()); offs = []; return 'ok'; });
    }`);
    await h.next((m) => m.t === 'ready');
    const watches = () => h.sent.filter((m) => m.t === 'call' && m.api === 'session.watchTurnEnd');
    expect(watches()).toEqual([
      { t: 'call', id: expect.any(String), api: 'session.watchTurnEnd', args: { on: true } },
    ]);
    h.deliver({ t: 'session-turn-end', sessionId: 's1' });
    h.deliver(call('7', 'tool.execute', { name: 'seen', args: {} }));
    expect(await h.next((m) => m.t === 'res' && m.id === '7')).toMatchObject({
      value: { content: 'a:s1' },
    });
    expect(h.sent.some((m) => m.t === 'log' && m.message.includes('listener boom'))).toBe(true);

    h.deliver(call('8', 'tool.execute', { name: 'off', args: {} }));
    await h.next((m) => m.t === 'res' && m.id === '8');
    // 关订阅脱离调用上下文，不带 invocationId
    expect(watches()).toHaveLength(2);
    expect(watches()[1]).toEqual({
      t: 'call',
      id: expect.any(String),
      api: 'session.watchTurnEnd',
      args: { on: false },
    });
    h.deliver({ t: 'session-turn-end', sessionId: 's2' });
    h.deliver(call('9', 'tool.execute', { name: 'seen', args: {} }));
    expect(await h.next((m) => m.t === 'res' && m.id === '9')).toMatchObject({
      value: { content: 'a:s1' },
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

  it('ui.view.emit 支持可选 sessionId，emitToSession 显式透传 sessionId（漏传不退化为广播）', async () => {
    const h = harness(`export function activate(enso) {
      enso.commands.register('push', async () => {
        await enso.ui.view.emit('broadcast', { n: 1 });
        await enso.ui.view.emit('scoped', { n: 2 }, { sessionId: 's1' });
        await enso.ui.view.emit('empty', null, { sessionId: '' });
        await enso.ui.view.emitToSession('s2', 'direct', { n: 3 });
        await enso.ui.view.emitToSession(undefined, 'missing', null);
      });
    }`);
    await h.next((m) => m.t === 'ready');
    h.deliver(call('6', 'command.run', { id: 'push' }));
    const seenIds = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const msg = await h.next(
        (m) => m.t === 'call' && m.api === 'ui.viewEvent' && !seenIds.has(m.id)
      );
      if (msg.t !== 'call') break;
      seenIds.add(msg.id);
      h.deliver({ t: 'res', id: msg.id, ok: true, value: null });
    }
    await h.next((m) => m.t === 'res' && m.id === '6');
    const viewCalls = h.sent
      .filter(
        (m): m is Extract<PluginHostToMain, { t: 'call' }> =>
          m.t === 'call' && m.api === 'ui.viewEvent'
      )
      .map((m) => m.args);
    expect(viewCalls).toEqual([
      { name: 'broadcast', data: { n: 1 } },
      { name: 'scoped', data: { n: 2 }, sessionId: 's1' },
      { name: 'empty', data: null, sessionId: '' },
      { name: 'direct', data: { n: 3 }, sessionId: 's2' },
      { name: 'missing', data: null, sessionId: null },
    ]);
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

  it('agent.run：调用返回后代理继续，进度回调、终态结算 Promise', async () => {
    const h = harness(`let run; const seen = [];
    export function activate(enso) {
      enso.renderer.handle('start', async () => {
        run = enso.agent.run({ prompt: '改写', context: 'conversation', onEvent: (e) => seen.push(e.type) })
          .then((r) => 'ok:' + r.text, (e) => 'err:' + e.code);
        return 'started';
      });
      enso.renderer.handle('result', async () => (await run) + '|' + seen.join(','));
    }`);
    await h.next((m) => m.t === 'ready');
    h.deliver(call('20', 'renderer.call', { method: 'start', args: null }));
    const hostCall = await h.next((m) => m.t === 'call' && m.api === 'agent.run');
    if (hostCall.t !== 'call') return;
    const args = hostCall.args as { runId: string };
    expect(args).toEqual({ prompt: '改写', context: 'conversation', runId: expect.any(String) });
    expect(hostCall.invocationId).toBe('inv-20');
    h.deliver({ t: 'res', id: hostCall.id, ok: true, value: null });
    await h.next((m) => m.t === 'res' && m.id === '20');
    h.deliver({
      t: 'agent-run',
      runId: args.runId,
      event: { type: 'tool-start', id: 't1', name: 'read', args: '{}' },
    });
    h.deliver({ t: 'agent-run', runId: 'other', event: { type: 'text', text: 'x' } });
    h.deliver({ t: 'agent-run', runId: args.runId, event: { type: 'end', ok: true, text: '好' } });
    h.deliver(call('21', 'renderer.call', { method: 'result', args: null }));
    expect(await h.next((m) => m.t === 'res' && m.id === '21')).toMatchObject({
      value: 'ok:好|tool-start',
    });
  });

  it('agent.run：signal 中止时脱离调用发 agent.cancel，终态以 ABORTED 拒绝', async () => {
    const h = harness(`let run; const ctrl = new AbortController();
    export function activate(enso) {
      enso.renderer.handle('start', async () => {
        run = enso.agent.run({ prompt: 'x', signal: ctrl.signal }).catch((e) => e.code);
        return null;
      });
      enso.renderer.handle('stop', async () => { ctrl.abort(); return null; });
      enso.renderer.handle('result', async () => run);
    }`);
    await h.next((m) => m.t === 'ready');
    h.deliver(call('30', 'renderer.call', { method: 'start', args: null }));
    const hostCall = await h.next((m) => m.t === 'call' && m.api === 'agent.run');
    if (hostCall.t !== 'call') return;
    const { runId } = hostCall.args as { runId: string };
    h.deliver({ t: 'res', id: hostCall.id, ok: true, value: null });
    h.deliver(call('31', 'renderer.call', { method: 'stop', args: null }));
    const cancel = await h.next((m) => m.t === 'call' && m.api === 'agent.cancel');
    expect(cancel).toEqual({
      t: 'call',
      id: expect.any(String),
      api: 'agent.cancel',
      args: { runId },
    });
    h.deliver({
      t: 'agent-run',
      runId,
      event: { type: 'end', ok: false, error: '已取消', aborted: true },
    });
    h.deliver(call('32', 'renderer.call', { method: 'result', args: null }));
    expect(await h.next((m) => m.t === 'res' && m.id === '32')).toMatchObject({ value: 'ABORTED' });
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

  it.runIf(process.platform !== 'win32')('子进程派生的孙进程在 shutdown 后也退出', async () => {
    const grandchild = `const g = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(g.pid); setInterval(() => {}, 1000);`;
    const h = harness(`import { spawn } from 'node:child_process';
      export function activate(enso) {
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}]);
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        enso.tools.register('pid', () => out.trim());
      }`);
    await h.next((m) => m.t === 'ready');
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      h.deliver(call(`c${i}`, 'tool.execute', { name: 'pid', args: {} }));
      const res = await h.next((m) => m.t === 'res' && m.id === `c${i}`);
      pid = Number((res as { value: { content: string } }).value.content);
      if (!pid) await new Promise((r) => setTimeout(r, 20));
    }
    expect(alive(pid)).toBe(true);
    try {
      h.deliver({ t: 'shutdown' });
      await h.next(() => h.exited() !== null);
      for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 10));
      expect(alive(pid)).toBe(false);
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
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

  it('日志开关关闭时不采集 console 输出，打开后立即恢复采集', () => {
    const sent: PluginHostToMain[] = [];
    const noop = (..._args: unknown[]) => {};
    const target = { log: noop, info: noop, warn: noop, error: noop, debug: noop };
    let enabled = false;
    captureConsole(
      target,
      (m) => sent.push(m),
      () => enabled
    );
    target.log('muted-info');
    target.warn('muted-warn');
    target.error('muted-error');
    expect(sent).toHaveLength(0);
    enabled = true;
    target.log('live-info');
    expect(sent).toEqual([{ t: 'log', level: 'info', message: 'live-info' }]);
  });

  it('init 与 set-logging 热切换采集，无需重启宿主', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-host-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'main.mjs'), 'export function activate() {}');
    const sent: PluginHostToMain[] = [];
    const changes: boolean[] = [];
    let enabled = true;
    const noop = (..._args: unknown[]) => {};
    const target = { log: noop, info: noop, warn: noop, error: noop, debug: noop };
    captureConsole(
      target,
      (m) => sent.push(m),
      () => enabled
    );
    let handler: (msg: unknown) => void = () => {};
    runPluginHost(
      {
        send: (m) => sent.push(m),
        onMessage: (h) => {
          handler = h;
        },
      },
      {
        onLoggingChange: (next) => {
          enabled = next;
          changes.push(next);
        },
      }
    );
    handler({
      t: 'init',
      pluginId: 'a.b',
      pluginRoot: dir,
      main: 'main.mjs',
      dataDir: dir,
      loggingEnabled: false,
    });
    expect(changes).toEqual([false]);
    target.log('muted');
    handler({ t: 'set-logging', enabled: true });
    target.log('live');
    handler({ t: 'set-logging', enabled: false });
    target.warn('muted-again');
    handler({ t: 'set-logging', enabled: 'yes' });
    expect(enabled).toBe(false);
    expect(changes).toEqual([false, true, false]);
    expect(sent.filter((m) => m.t === 'log')).toEqual([
      { t: 'log', level: 'info', message: 'live' },
    ]);
  });
});
