import { execFile } from 'node:child_process';
import { buildRemoteCommand, buildSshExecArgs } from '@shared/ssh';

/** ssh 探测超时(秒);BatchMode 下认证不可交互,挂死风险低但连接可能长等 */
const CONNECT_TIMEOUT_SECONDS = 10;
/** 整个 probe 进程的硬超时(ms),覆盖 DNS/代理等 ConnectTimeout 不管的阶段 */
const PROBE_TIMEOUT_MS = 15_000;

/** 构建 `ssh <host> test -d <path>` 的 argv;路径经单引号防远端 shell 展开 */
export function buildSshProbeArgs(host: string, remotePath: string): string[] {
  return buildSshExecArgs(host, buildRemoteCommand(['test', '-d', remotePath]), {
    connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS,
  });
}

/** 把 ssh 退出码 + stderr 归为用户可读错误(中文,面向 AddProjectDialog 内联展示) */
export function classifySshProbeFailure(code: number, stderr: string): string {
  if (code === 255) {
    if (/permission denied|authentication/i.test(stderr)) {
      return 'SSH 认证失败:请确认已配置密钥登录(BatchMode 不支持密码交互)。';
    }
    return `无法连接到远程主机:${stderr.trim() || '连接失败'}`;
  }
  return '远程路径不存在或不是目录。';
}

/**
 * 用系统 ssh 校验远端目录存在。成功 resolve null,失败 resolve 可读错误文案。
 * 不抛异常——调用方(IPC handler)直接把文案回给 renderer。
 */
export function sshProbeDirectory(host: string, remotePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ssh',
      buildSshProbeArgs(host, remotePath),
      { timeout: PROBE_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (!error) return resolve(null);
        const code = typeof (error as { code?: unknown }).code === 'number'
          ? ((error as { code?: number }).code as number)
          : 255;
        if ((error as { killed?: boolean }).killed) {
          return resolve('连接远程主机超时。');
        }
        resolve(classifySshProbeFailure(code, stderr ?? ''));
      }
    );
  });
}
