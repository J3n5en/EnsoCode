import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BashOperations } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { HARDENED_ENV, hardenedEnv, withHardenedEnv } from './hardenedEnv';

describe('hardenedEnv', () => {
  it('整组注入非交互环境变量', () => {
    const env = hardenedEnv({ PATH: '/usr/bin' }, { shell: 'bash' });
    expect(env).toMatchObject({
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
      PS1: '',
      PROMPT_COMMAND: '',
      DEBIAN_FRONTEND: 'noninteractive',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      MANPAGER: 'cat',
      LESS: 'FRX',
      GIT_EDITOR: 'false',
      GIT_SEQUENCE_EDITOR: 'false',
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      npm_config_yes: 'true',
    });
  });

  it('上述键以外的调用方 env 原样保留，且不改动传入对象', () => {
    const base = { PATH: '/opt/bin', PI_MODEL: 'm1', HOME: '/home/john.doe', PAGER: 'less' };
    const env = hardenedEnv(base, { shell: 'bash' });
    expect(env.PATH).toBe('/opt/bin');
    expect(env.PI_MODEL).toBe('m1');
    expect(env.HOME).toBe('/home/john.doe');
    expect(env.PAGER).toBe('cat');
    expect(base.PAGER).toBe('less');
  });

  it('已有 GIT_SSH_COMMAND（如自定义密钥）时保留原命令，只补 BatchMode', () => {
    const env = hardenedEnv({ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/deploy_key' }, { shell: 'bash' });
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/deploy_key -o BatchMode=yes');
    const already = hardenedEnv(
      { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -i k' },
      { shell: 'bash' }
    );
    expect(already.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes -i k');
  });

  // 真实场景:Windows 用户用 GIT_SSH 指向 plink;git 里 GIT_SSH_COMMAND 优先于 GIT_SSH,
  // 注入的默认命令会把用户的 ssh 程序整个顶掉,push/fetch 报 publickey
  it.skipIf(process.platform === 'win32')(
    '用户已设 GIT_SSH 时，git 仍调用用户指定的 ssh 程序',
    () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'enso-git-ssh-'));
      try {
        // 命名为 ssh:git 按 OpenSSH 处理,不先跑 -G 探测;只记录调用,不发起真实连接
        const fakeSsh = path.join(tmp, 'ssh');
        const log = path.join(tmp, 'ssh.log');
        writeFileSync(fakeSsh, `#!/bin/sh\necho "$@" >> '${log}'\nexit 1\n`);
        chmodSync(fakeSsh, 0o755);
        const env = hardenedEnv(
          {
            PATH: process.env.PATH,
            HOME: tmp,
            // 隔离本机 git 配置(全局 core.sshCommand 会盖过 GIT_SSH)
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_SSH: fakeSsh,
          },
          { shell: 'bash' }
        );
        // 端口 1 无人监听:万一走了真 ssh 也是立即拒绝连接,不碰 known_hosts
        spawnSync('git', ['ls-remote', 'ssh://git@127.0.0.1:1/repo.git'], { cwd: tmp, env });
        expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toContain('127.0.0.1');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  );

  it('powershell 不注入 bash 专属的 PS1 / PROMPT_COMMAND', () => {
    const env = hardenedEnv({}, { shell: 'powershell' });
    expect(env).not.toHaveProperty('PS1');
    expect(env).not.toHaveProperty('PROMPT_COMMAND');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('HARDENED_ENV 覆盖裁决列出的全部键', () => {
    expect(Object.keys(HARDENED_ENV)).toHaveLength(23);
  });

  it('清空 BASH_ENV / ENV，避免调用方环境里的 rc 脚本在每条命令前执行', () => {
    const env = hardenedEnv(
      { BASH_ENV: '/home/john.doe/slow-setup.sh', ENV: '/home/john.doe/env.sh' },
      { shell: 'bash' }
    );
    expect(env.BASH_ENV).toBe('');
    expect(env.ENV).toBe('');
  });
});

describe('withHardenedEnv', () => {
  const capture = () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const inner: BashOperations = {
      exec: async (_command, _cwd, options) => {
        seen.push(options.env);
        return { exitCode: 0 };
      },
    };
    return { inner, seen };
  };

  it('把硬化 env 交给底层 exec，保留调用方传入的其它键与选项', async () => {
    const { inner, seen } = capture();
    const signal = new AbortController().signal;
    await withHardenedEnv(inner, 'bash').exec('true', '/', {
      onData: () => {},
      signal,
      timeout: 3,
      env: { PI_SESSION_ID: 's1' },
    });
    expect(seen[0]).toMatchObject({ PI_SESSION_ID: 's1', GIT_TERMINAL_PROMPT: '0' });
  });

  it('调用方未传 env 时以 process.env 为底', async () => {
    const { inner, seen } = capture();
    await withHardenedEnv(inner, 'bash').exec('true', '/', { onData: () => {} });
    expect(seen[0]?.PATH).toBe(process.env.PATH);
    expect(seen[0]?.NO_COLOR).toBe('1');
  });
});
