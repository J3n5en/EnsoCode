import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectRestartMethod, reexecScript } from './reexec';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-reexec-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('重启方式探测', () => {
  it('systemd / enso 守护标记算 supervisor', () => {
    expect(detectRestartMethod({ INVOCATION_ID: 'x' }, 1234)).toBe('supervisor');
    expect(detectRestartMethod({ ENSO_SUPERVISED: '1' }, 1234)).toBe('supervisor');
  });

  it('pm2 算 supervisor', () => {
    expect(detectRestartMethod({ pm_id: '0' }, 1234)).toBe('supervisor');
    expect(detectRestartMethod({ PM2_HOME: '/x' }, 1234)).toBe('supervisor');
  });

  it('PID 1（容器主进程）只能外部重启', () => {
    expect(detectRestartMethod({}, 1)).toBe('manual');
  });

  it('前台裸跑用 reexec 自拉', () => {
    expect(detectRestartMethod({}, 1234)).toBe('reexec');
  });
});

describe('reexec 启动脚本', () => {
  it('等旧进程退出后 exec 同一条命令行，输出进日志', () => {
    const script = reexecScript({
      pid: 4321,
      execPath: '/usr/local/bin/node',
      argv: ['out/server/index.js', 'start', '--web'],
      logFile: '/data/restart.log',
    });
    expect(script).toContain('kill -0 4321');
    expect(script).toContain('exec "/usr/local/bin/node" "out/server/index.js" "start" "--web"');
    expect(script).toContain('"/data/restart.log"');
  });

  it('参数里的引号与空格被转义', () => {
    const script = reexecScript({
      pid: 1,
      execPath: '/opt/my node/bin/node',
      argv: ['index.js', 'start', '--name', 'a"b'],
      logFile: '/l.log',
    });
    expect(script).toContain('"/opt/my node/bin/node"');
    expect(script).toContain('"a\\"b"');
  });
});
