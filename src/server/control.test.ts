import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseControlCommand, serveControlConnection } from './control';

describe('parseControlCommand', () => {
  it('accepts pair and devices', () => {
    expect(parseControlCommand('{"cmd":"pair"}')).toEqual({ cmd: 'pair' });
    expect(parseControlCommand('{"cmd":"devices"}')).toEqual({ cmd: 'devices' });
    expect(parseControlCommand('{"cmd":"update"}')).toEqual({ cmd: 'update' });
    expect(parseControlCommand('{"cmd":"status"}')).toEqual({ cmd: 'status' });
  });

  it('requires an id to revoke', () => {
    expect(parseControlCommand('{"cmd":"revoke","id":" dev "}')).toEqual({
      cmd: 'revoke',
      id: 'dev',
    });
    expect(parseControlCommand('{"cmd":"revoke"}')).toEqual({ error: 'revoke requires id' });
  });

  it('rejects unknown input', () => {
    expect(parseControlCommand('nope')).toEqual({ error: 'invalid json' });
    expect(parseControlCommand('{"cmd":"quit"}')).toEqual({ error: 'unknown command' });
  });

  it('插件命令：按动作校验参数', () => {
    const parse = (v: unknown) => parseControlCommand(JSON.stringify(v));
    expect(parse({ cmd: 'plugin', action: 'list' })).toEqual({ cmd: 'plugin', action: 'list' });
    expect(parse({ cmd: 'plugin', action: 'stage', path: '/srv/p.zip' })).toEqual({
      cmd: 'plugin',
      action: 'stage',
      path: '/srv/p.zip',
    });
    expect(parse({ cmd: 'plugin', action: 'stage', path: 'rel/p' })).toEqual({
      error: 'plugin stage requires an absolute path',
    });
    expect(parse({ cmd: 'plugin', action: 'stage', url: 'https://example.com/a.zip' })).toEqual({
      cmd: 'plugin',
      action: 'stage',
      url: 'https://example.com/a.zip',
    });
    expect(parse({ cmd: 'plugin', action: 'stage', url: 'file:///tmp/a.zip' })).toEqual({
      error: 'plugin stage url must be http or https',
    });
    expect(
      parse({
        cmd: 'plugin',
        action: 'stage',
        path: '/srv/p.zip',
        url: 'https://example.com/a.zip',
      })
    ).toEqual({
      error: 'plugin stage requires an absolute path or an http(s) url',
    });
    expect(parse({ cmd: 'plugin', action: 'commit', token: 't1' })).toEqual({
      cmd: 'plugin',
      action: 'commit',
      token: 't1',
    });
    expect(parse({ cmd: 'plugin', action: 'enable', id: 'a.b' })).toEqual({
      cmd: 'plugin',
      action: 'enable',
      id: 'a.b',
    });
    expect(parse({ cmd: 'plugin', action: 'enable' })).toEqual({
      error: 'plugin enable requires id',
    });
    for (const action of ['inject-anywhere', 'inject-current'])
      expect(parse({ cmd: 'plugin', action, id: 'a.b' })).toEqual({
        cmd: 'plugin',
        action,
        id: 'a.b',
      });
    expect(parse({ cmd: 'plugin', action: 'notice-dismiss' })).toEqual({
      cmd: 'plugin',
      action: 'notice-dismiss',
    });
    expect(parse({ cmd: 'plugin', action: 'explode' })).toEqual({ error: 'unknown plugin action' });
  });

  it('插件配置命令：config-get 要 id，config-set 的值只能是字符串或 null', () => {
    expect(parseControlCommand(JSON.stringify({ cmd: 'plugin', action: 'check' }))).toEqual({
      cmd: 'plugin',
      action: 'check',
    });
    expect(
      parseControlCommand(JSON.stringify({ cmd: 'plugin', action: 'restage', id: 'a.b' }))
    ).toEqual({ cmd: 'plugin', action: 'restage', id: 'a.b' });
    expect(
      parseControlCommand(JSON.stringify({ cmd: 'plugin', action: 'logs', id: 'a.b' }))
    ).toEqual({
      cmd: 'plugin',
      action: 'logs',
      id: 'a.b',
    });
    const parse = (v: unknown) => parseControlCommand(JSON.stringify(v));
    expect(parse({ cmd: 'plugin', action: 'config-get', id: 'a.b' })).toEqual({
      cmd: 'plugin',
      action: 'config-get',
      id: 'a.b',
    });
    expect(
      parse({ cmd: 'plugin', action: 'config-set', id: 'a.b', values: { k: 'v', t: null } })
    ).toEqual({ cmd: 'plugin', action: 'config-set', id: 'a.b', values: { k: 'v', t: null } });
    expect(parse({ cmd: 'plugin', action: 'config-set', id: 'a.b', values: { k: 1 } })).toEqual({
      error: 'plugin config-set requires id and string values',
    });
    expect(parse({ cmd: 'plugin', action: 'config-set', values: {} })).toEqual({
      error: 'plugin config-set requires id and string values',
    });
  });
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 收集窗口内的未捕获异常：宿主进程没有兜底，出现任何一个都意味着 enso-server 整个退出 */
async function collectUncaught(run: () => Promise<void>): Promise<unknown[]> {
  const uncaught: unknown[] = [];
  process.setUncaughtExceptionCaptureCallback((error) => uncaught.push(error));
  try {
    await run();
    await delay(100);
  } finally {
    process.setUncaughtExceptionCaptureCallback(null);
  }
  return uncaught;
}

/** 照 cli.ts 的客户端：发一行即半关闭，读完对端回的全部内容 */
function send(file: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const client = createConnection(file);
    client.on('data', (chunk) => {
      data += chunk.toString();
    });
    client.on('error', reject);
    client.on('close', () => resolve(data));
    client.end(payload);
  });
}

// unix socket 路径在 Windows 上不适用
describe.skipIf(process.platform === 'win32')('serveControlConnection', () => {
  let dir: string;
  let file: string;
  let server: Server | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'enso-ctl-'));
    file = path.join(dir, 'server.sock');
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function listen(handle: (line: string) => Promise<unknown>, onSocket?: (s: Socket) => void) {
    server = createServer({ allowHalfOpen: true }, (socket) => {
      onSocket?.(socket);
      serveControlConnection(socket, handle);
    });
    return new Promise<void>((resolve) => server?.listen(file, () => resolve()));
  }

  // 真实场景：`enso-server update` 在宿主里要等 npm cache add（可达 15 分钟），用户 Ctrl-C 后
  // 宿主回包写到已断开的 socket 报 EPIPE；plugin check / plugin stage <url> / pair 同理
  it('客户端在长命令完成前断开，宿主回包不崩溃且继续服务', async () => {
    let release = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let received = () => {};
    const got = new Promise<void>((resolve) => {
      received = resolve;
    });
    const serverClosed: Promise<void>[] = [];
    await listen(
      async (line) => {
        received();
        if (line.includes('update')) await slow;
        return { ok: true, line };
      },
      (socket) => serverClosed.push(new Promise((resolve) => socket.once('close', resolve)))
    );

    const uncaught = await collectUncaught(async () => {
      const client = createConnection(file);
      client.on('error', () => {});
      client.end('{"cmd":"update"}\n');
      await got;
      client.destroy();
      await new Promise((resolve) => client.once('close', resolve));
      release();
      await Promise.race([serverClosed[0], delay(500)]);
    });

    expect(uncaught).toEqual([]);
    expect(await send(file, '{"cmd":"status"}\n')).toBe(
      '{"ok":true,"line":"{\\"cmd\\":\\"status\\"}"}\n'
    );
  });

  // 协议是一个连接一条命令；同一连接发来多行时，第二次回包写在 end 之后，同样会打崩宿主
  it('同一连接发来多行命令只回一行，宿主不崩溃', async () => {
    await listen(async (line) => ({ ok: true, line }));
    let reply = '';
    const uncaught = await collectUncaught(async () => {
      reply = await send(file, '{"cmd":"status"}\n{"cmd":"devices"}\n');
    });
    expect(uncaught).toEqual([]);
    expect(reply.split('\n').filter(Boolean)).toHaveLength(1);
  });
});
