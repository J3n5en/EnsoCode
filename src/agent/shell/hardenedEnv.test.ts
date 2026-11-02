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

  it('powershell 不注入 bash 专属的 PS1 / PROMPT_COMMAND', () => {
    const env = hardenedEnv({}, { shell: 'powershell' });
    expect(env).not.toHaveProperty('PS1');
    expect(env).not.toHaveProperty('PROMPT_COMMAND');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('HARDENED_ENV 覆盖裁决列出的全部键', () => {
    expect(Object.keys(HARDENED_ENV)).toHaveLength(21);
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
