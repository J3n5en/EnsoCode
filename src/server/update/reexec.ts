import { spawn } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ServerRestartMethod } from '@shared/types/updater';

/**
 * 无守护时的自重启：写一个小 shell 脚本，脱离本进程运行，等本进程退出后用同一条命令行
 * 把服务拉起来（exec 替换脚本进程，日志落在数据目录，脚本留在数据目录便于排查）。
 * systemd / pm2 托管时不走这条路（守护进程自己会拉），容器 PID 1 场景拉不起来也没有意义。
 */

export function detectRestartMethod(
  env: Record<string, string | undefined>,
  pid: number
): ServerRestartMethod {
  if (
    env.ENSO_SUPERVISED === '1' ||
    env.INVOCATION_ID ||
    env.pm_id !== undefined ||
    env.PM2_HOME !== undefined
  ) {
    return 'supervisor';
  }
  // 容器里作为主进程跑：退出即容器结束，reexec 拉起来的孤儿进程也随容器消失
  if (pid === 1) return 'manual';
  return 'reexec';
}

const shQuote = (value: string) => `"${value.replace(/(["\\$`])/g, '\\$1')}"`;

export function reexecScript(options: {
  pid: number;
  execPath: string;
  argv: string[];
  logFile: string;
}): string {
  const command = [shQuote(options.execPath), ...options.argv.map(shQuote)].join(' ');
  return [
    '#!/bin/sh',
    '# enso-server 自重启：等旧进程退出后用同一条命令行拉起（无 systemd/pm2 时）',
    `while kill -0 ${options.pid} 2>/dev/null; do sleep 0.3; done`,
    `exec ${command} >> ${shQuote(options.logFile)} 2>&1`,
    '',
  ].join('\n');
}

/** 生成脚本并脱离本进程启动；脚本等本进程退出后 exec 服务命令 */
export function spawnReexec(dataDir: string): void {
  const scriptPath = path.join(dataDir, 'reexec-restart.sh');
  const logFile = path.join(dataDir, 'restart.log');
  writeFileSync(
    scriptPath,
    reexecScript({
      pid: process.pid,
      execPath: process.execPath,
      argv: process.argv.slice(1),
      logFile,
    }),
    { mode: 0o700 }
  );
  chmodSync(scriptPath, 0o700);
  const child = spawn('/bin/sh', [scriptPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
}
