import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildRemoteCommand,
  buildSshExecArgs,
  type SshExecArgsOptions,
  shellQuote,
} from '@shared/ssh';

const CONNECT_TIMEOUT_SECONDS = 10;
const PROBE_TIMEOUT_MS = 15_000;

export function buildSshProbeArgs(
  host: string,
  remotePath: string,
  options: SshExecArgsOptions = {}
): string[] {
  return buildSshExecArgs(host, buildRemoteCommand(['test', '-d', remotePath]), {
    connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS,
    ...options,
  });
}

export function buildSshLoginProbeArgs(host: string, options: SshExecArgsOptions = {}): string[] {
  return buildSshExecArgs(host, buildRemoteCommand(['true']), {
    connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS,
    ...options,
  });
}

export function classifySshProbeFailure(
  code: number,
  stderr: string,
  auth: SshExecArgsOptions['auth'] = 'key'
): string {
  if (code === 255) {
    if (/permission denied|authentication/i.test(stderr)) {
      return auth === 'password'
        ? 'SSH 认证失败:用户名或密码不正确。'
        : 'SSH 认证失败:请确认已配置密钥登录。';
    }
    return `无法连接到远程主机:${stderr.trim() || '连接失败'}`;
  }
  return '远程路径不存在或不是目录。';
}

function probeEnv(password?: string): NodeJS.ProcessEnv | undefined {
  if (!password) return undefined;
  const helper = path.join(tmpdir(), 'enso-ssh-askpass.sh');
  writeFileSync(helper, '#!/bin/sh\nprintf %s "$ENSO_SSH_ASKPASS_PASSWORD"\n', { mode: 0o700 });
  return {
    ...process.env,
    SSH_ASKPASS: helper,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || ':',
    ENSO_SSH_ASKPASS_PASSWORD: password,
    SSH_AUTH_SOCK: '',
  };
}

function runSshProbe(
  args: string[],
  options: SshExecArgsOptions & { password?: string },
  onOtherCode: string
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ssh',
      args,
      { timeout: PROBE_TIMEOUT_MS, env: probeEnv(options.password) ?? process.env },
      (error, _stdout, stderr) => {
        if (!error) return resolve(null);
        const code =
          typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code?: number }).code as number)
            : 255;
        if ((error as { killed?: boolean }).killed) return resolve('连接远程主机超时。');
        if (code === 255) return resolve(classifySshProbeFailure(code, stderr ?? '', options.auth));
        resolve(onOtherCode);
      }
    );
  });
}

export function sshProbeDirectory(
  host: string,
  remotePath: string,
  options: SshExecArgsOptions & { password?: string } = {}
): Promise<string | null> {
  return runSshProbe(
    buildSshProbeArgs(host, remotePath, options),
    options,
    '远程路径不存在或不是目录。'
  );
}

/** 列远程子目录脚本：首行 pwd 解析真实绝对路径（支持 ~ 起点），隐藏目录不列 */
export function buildSshListDirsScript(path?: string): string {
  const target = path ? shellQuote(path) : '~';
  return `cd ${target} && pwd && find . -mindepth 1 -maxdepth 1 -type d ! -name '.*'`;
}

/** 解析列目录输出；首行非绝对路径视为异常返回 null */
export function parseSshListDirsOutput(stdout: string): { path: string; dirs: string[] } | null {
  const lines = stdout.split('\n');
  const path = lines[0]?.trim();
  if (!path?.startsWith('/')) return null;
  const dirs = lines
    .slice(1)
    .filter((line) => line.startsWith('./'))
    .map((line) => line.slice(2))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return { path, dirs };
}

export function sshListRemoteDirs(
  host: string,
  path: string | undefined,
  options: SshExecArgsOptions & { password?: string } = {}
): Promise<{ ok: true; path: string; dirs: string[] } | { ok: false; error: string }> {
  const args = buildSshExecArgs(host, buildRemoteCommand(buildSshListDirsScript(path)), {
    connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS,
    ...options,
  });
  return new Promise((resolve) => {
    execFile(
      'ssh',
      args,
      { timeout: PROBE_TIMEOUT_MS, env: probeEnv(options.password) ?? process.env },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as { killed?: boolean }).killed) {
            return resolve({ ok: false, error: '连接远程主机超时。' });
          }
          const code =
            typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code?: number }).code as number)
              : 255;
          return resolve({
            ok: false,
            error:
              code === 255
                ? classifySshProbeFailure(code, stderr ?? '', options.auth)
                : '远程路径不存在或不是目录。',
          });
        }
        const parsed = parseSshListDirsOutput(stdout ?? '');
        resolve(parsed ? { ok: true, ...parsed } : { ok: false, error: '远程命令输出异常。' });
      }
    );
  });
}

export function sshProbeLogin(
  host: string,
  options: SshExecArgsOptions & { password?: string } = {}
): Promise<string | null> {
  return runSshProbe(buildSshLoginProbeArgs(host, options), options, '远程命令执行失败。');
}
