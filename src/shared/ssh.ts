/**
 * ssh 命令构建的纯函数(零 node 依赖,main 与 agent worker 共用)。
 * 执行实体各层自持:main 用 execFile(sshProbe),worker 用 spawn(SshExecutor)。
 */

/** POSIX shell 单引号安全包裹(内嵌单引号转 '\'' ) */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface RemoteCommandOptions {
  /** 远端工作目录,经 cd 前缀进入 */
  cwd?: string;
}

/**
 * 组装发给远端的单参数命令字符串。
 * - argv 数组:逐参 quote 后拼接(精确参数语义,无 shell 特性)
 * - 字符串:视为脚本,经 `bash -lc` 执行(bash 工具用,-l 加载远端 PATH)
 */
export function buildRemoteCommand(
  command: string[] | string,
  options: RemoteCommandOptions = {}
): string {
  const body = Array.isArray(command)
    ? command.map(shellQuote).join(' ')
    : `bash -lc ${shellQuote(command)}`;
  return options.cwd ? `cd ${shellQuote(options.cwd)} && ${body}` : body;
}

export interface SshExecArgsOptions {
  /** ControlMaster socket 路径模板(如 <dir>/%C);缺省不启用连接复用 */
  controlPath?: string;
  /** 连接复用保活秒数,默认 600 */
  controlPersistSeconds?: number;
  /** 建连超时秒数,默认 10 */
  connectTimeoutSeconds?: number;
  /** key=BatchMode;password=ASKPASS 侧关 BatchMode */
  auth?: 'key' | 'password';
  /** 非 22 才写 -p */
  port?: number;
}

/** 有 user 则 user@host,否则 host(ssh config 别名) */
export function resolveSshTarget(conn: { host: string; user?: string }): string {
  return conn.user ? `${conn.user}@${conn.host}` : conn.host;
}

/** 把远端命令拼成本地 shell(spawn shell:true)可执行的单条 ssh 命令(后台任务/gate 用) */
export function buildSshShellCommand(
  host: string,
  script: string,
  options: RemoteCommandOptions & SshExecArgsOptions = {}
): string {
  const remoteCommand = buildRemoteCommand(script, { cwd: options.cwd });
  const args = buildSshExecArgs(host, remoteCommand, options);
  return `ssh ${args.map(shellQuote).join(' ')}`;
}

/** 构建 `ssh <opts> -- <host> <remoteCommand>` 的 argv */
export function buildSshExecArgs(
  host: string,
  remoteCommand: string,
  options: SshExecArgsOptions = {}
): string[] {
  const args: string[] = [];
  if (options.auth !== 'password') args.push('-o', 'BatchMode=yes');
  else {
    args.push(
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'NumberOfPasswordPrompts=1',
      '-o',
      'IdentitiesOnly=yes'
    );
  }
  if (options.port && options.port !== 22) args.push('-p', String(options.port));
  args.push('-o', `ConnectTimeout=${options.connectTimeoutSeconds ?? 10}`);
  if (options.controlPath) {
    args.push(
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${options.controlPath}`,
      '-o',
      `ControlPersist=${options.controlPersistSeconds ?? 600}`
    );
  }
  args.push('--', host, remoteCommand);
  return args;
}
