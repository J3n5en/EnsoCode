import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ELEVATE_DECLINED_MARKER, ELEVATE_UNAVAILABLE_MARKER } from '@shared/elevation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElevationBroker } from './broker';
import { type InspectProcess, startElevationServer } from './server';

const posix = process.platform !== 'win32';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const SUDO_PID = 4242;

async function setup(options: { sudoArgs?: string; canPresent?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'enso-elev-'));
  const broker = new ElevationBroker({
    canPresent: () => options.canPresent ?? true,
    changed: () => {},
  });
  const inspect: InspectProcess = async (pid) =>
    pid === SUDO_PID
      ? {
          ppid: 1,
          comm: '/usr/bin/sudo',
          args: options.sudoArgs ?? '/usr/bin/sudo -k -A -- /bin/bash -c id -u',
        }
      : { ppid: SUDO_PID, comm: 'node', args: `node ${path.join(dir, 'askpass.cjs')} Password:` };
  const server = startElevationServer({ dir, broker, inspect, execPath: process.execPath });
  await server.ready;
  cleanups.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, broker, server };
}

function runHelper(askpassPath: string) {
  const child = spawn(askpassPath, ['Password:'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d;
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  );
  return { child, done };
}

describe.runIf(posix)('startElevationServer', () => {
  it('目录与 helper 只有本用户可访问', async () => {
    const { dir, server } = await setup();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(server.askpassPath).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, 'askpass.cjs')).mode & 0o777).toBe(0o600);
  });

  it('用户输入口令后 helper 把它交给 sudo（stdout）', async () => {
    const { broker, server } = await setup();
    const helper = runHelper(server.askpassPath);
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1), { timeout: 5000 });
    expect(broker.list()[0]?.command).toBe('id -u');
    broker.answer(broker.list()[0]?.id as string, 'p@ss word');
    const result = await helper.done;
    expect(result).toEqual({ code: 0, stdout: 'p@ss word\n', stderr: '' });
  });

  it('用户拒绝：helper 不输出口令，stderr 带拒绝标记', async () => {
    const { broker, server } = await setup();
    const helper = runHelper(server.askpassPath);
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1), { timeout: 5000 });
    broker.answer(broker.list()[0]?.id as string, null);
    const result = await helper.done;
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(ELEVATE_DECLINED_MARKER);
  });

  it('没有可用界面时返回 unavailable 标记', async () => {
    const { server } = await setup({ canPresent: false });
    const result = await runHelper(server.askpassPath).done;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(ELEVATE_UNAVAILABLE_MARKER);
  });

  it('sudo 命令不是 Enso 拼出的格式时拒绝，不弹给用户', async () => {
    const { broker, server } = await setup({ sudoArgs: '/usr/bin/sudo -A cat /etc/shadow' });
    const result = await runHelper(server.askpassPath).done;
    expect(result.stderr).toContain(ELEVATE_DECLINED_MARKER);
    expect(broker.list()).toEqual([]);
  });

  it('token 不对的连接直接拒绝', async () => {
    const { broker, dir } = await setup();
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(path.join(dir, 's.sock'), () =>
        socket.write(`${JSON.stringify({ token: 'nope', pid: process.pid })}\n`)
      );
      let buf = '';
      socket.on('data', (d) => {
        buf += d;
      });
      socket.on('close', () => resolve(buf));
    });
    expect(JSON.parse(reply)).toEqual({ kind: 'declined' });
    expect(broker.list()).toEqual([]);
  });

  it('helper 被杀（sudo 中止）后请求出列', async () => {
    const { broker, server } = await setup();
    const helper = runHelper(server.askpassPath);
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1), { timeout: 5000 });
    helper.child.kill('SIGKILL');
    await helper.done;
    await vi.waitFor(() => expect(broker.list()).toEqual([]), { timeout: 5000 });
  });
});
