import {
  type BashOperations,
  createBashToolDefinition,
  createLocalBashOperations,
  createLocalPowerShellOperations,
  createPowerShellToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { childProfileShell } from '@shared/childProfileTools';
import type { WindowsLocalShell } from '@shared/windowsLocalShell';
import { withDetachableExec } from './foregroundCommand';
import { withFileBackedExec } from './shell/detachedRun';
import { withHardenedEnv } from './shell/hardenedEnv';

export type SessionShellKind = 'bash' | 'powershell';

export function resolveSessionShellKind(input: {
  platform: string;
  remote?: boolean;
  preference?: WindowsLocalShell;
}): SessionShellKind {
  return childProfileShell(input);
}

export function createSessionCommandTool(input: {
  cwd: string;
  platform?: NodeJS.Platform;
  remote?: boolean;
  preference?: WindowsLocalShell;
  operations?: BashOperations;
}): ReturnType<typeof createBashToolDefinition> {
  const kind = resolveSessionShellKind({
    platform: input.platform ?? process.platform,
    remote: input.remote,
    preference: input.preference,
  });
  // 本地 POSIX bash：前台命令输出直写文件，转后台后重启时能脱离 worker 活下来（Windows 没有进程组 / setsid，照旧走管道）
  const local =
    kind === 'powershell'
      ? createLocalPowerShellOperations
      : (input.platform ?? process.platform) === 'win32'
        ? createLocalBashOperations
        : () => withFileBackedExec(createLocalBashOperations());
  // 远程 operations 由 ssh 执行器负责环境，不套本地硬化
  const operations = input.operations ?? withHardenedEnv(local(), kind);
  const options = { operations: withDetachableExec(operations) };
  return kind === 'powershell'
    ? createPowerShellToolDefinition(input.cwd, options)
    : createBashToolDefinition(input.cwd, options);
}
