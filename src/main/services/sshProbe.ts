import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRemoteCommand, buildSshExecArgs, type SshExecArgsOptions } from '@shared/ssh';

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

export function sshProbeLogin(
  host: string,
  options: SshExecArgsOptions & { password?: string } = {}
): Promise<string | null> {
  return runSshProbe(buildSshLoginProbeArgs(host, options), options, '远程命令执行失败。');
}
