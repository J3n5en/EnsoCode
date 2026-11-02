import type { BashOperations } from '@earendil-works/pi-coding-agent';

/**
 * 非交互硬化：让需要终端输入的程序立刻失败而不是挂起等输入。
 *
 * 不上 PTY 是有意的：pi 本地执行是 stdin:'ignore' + detached（POSIX 下即 setsid、没有控制终端），
 * 读 stdin 立即 EOF、打开 /dev/tty 立即 ENXIO，交互提示本来就 fail-fast；
 * 换成 PTY 反而会把这些 fail-fast 变成无限等待。这里只补齐「让工具别去问」的环境变量。
 */
export const HARDENED_ENV: Readonly<Record<string, string>> = Object.freeze({
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

/** 只对 bash 有意义的提示符变量 */
const BASH_ONLY = new Set(['PS1', 'PROMPT_COMMAND']);

export type HardenedShell = 'bash' | 'powershell';

/** 在调用方 env 之上覆盖硬化键；其它键原样保留，不改动传入对象 */
export function hardenedEnv(
  base: NodeJS.ProcessEnv,
  options: { shell: HardenedShell }
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(HARDENED_ENV)) {
    if (options.shell !== 'bash' && BASH_ONLY.has(key)) continue;
    env[key] = value;
  }
  // 用户自配的 GIT_SSH_COMMAND（如 -i 指定部署密钥）整体替换会让 git over ssh 直接失效：保留原命令只补 BatchMode
  const userSsh = base.GIT_SSH_COMMAND?.trim();
  if (userSsh) {
    env.GIT_SSH_COMMAND = /BatchMode/.test(userSsh) ? userSsh : `${userSsh} -o BatchMode=yes`;
  }
  return env;
}

/** 包装本地 bash / powershell operations：每次 exec 都跑在硬化 env 里（远程 operations 不经过这里） */
export function withHardenedEnv(inner: BashOperations, shell: HardenedShell): BashOperations {
  return {
    exec(command, cwd, options) {
      return inner.exec(command, cwd, {
        ...options,
        env: hardenedEnv(options.env ?? process.env, { shell }),
      });
    },
  };
}
