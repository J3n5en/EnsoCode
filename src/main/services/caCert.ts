import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CA_CERT_ENV, type CaCertError, type CaCertStatus } from '@shared/caCert';
import { restartAgentWorker } from './agentHost';

/** 只校验路径存在且可读，不读证书内容 */
export function checkCaCertFile(path: string): CaCertError | null {
  if (!isAbsolute(path)) return 'not-absolute';
  try {
    if (!statSync(path).isFile()) return 'not-file';
  } catch {
    return 'not-found';
  }
  try {
    accessSync(path, constants.R_OK);
    return null;
  } catch {
    return 'not-readable';
  }
}

/** 优先级：启动时已有 env > 设置项 > 登录 shell 探测 */
export function resolveExtraCaCert(input: {
  inherited?: string;
  setting: string;
  shell?: string;
  check?: (path: string) => CaCertError | null;
}): CaCertStatus {
  const check = input.check ?? checkCaCertFile;
  const settingPath = input.setting.trim();
  const inherited = input.inherited?.trim();
  if (inherited) return { source: 'env', path: inherited, settingPath };
  if (settingPath) {
    const error = check(settingPath);
    return error
      ? { source: 'none', path: '', settingPath, error }
      : { source: 'setting', path: settingPath, settingPath };
  }
  const shell = input.shell?.trim();
  if (shell && !check(shell)) return { source: 'shell', path: shell, settingPath };
  return { source: 'none', path: '', settingPath };
}

export class CaCertConfig {
  private setting = '';
  private shell: string | undefined;
  private current: CaCertStatus;
  private readonly inherited: string | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly restartWorker: () => Promise<unknown>,
    private readonly check: (path: string) => CaCertError | null = checkCaCertFile
  ) {
    this.inherited = env[CA_CERT_ENV];
    this.current = this.resolve();
  }

  status(): CaCertStatus {
    return this.current;
  }

  /** 启动早期、fork worker 之前调用 */
  initFromConfig(setting: unknown): CaCertStatus {
    this.setting = typeof setting === 'string' ? setting.trim() : '';
    this.commit();
    return this.current;
  }

  applyShellValue(value: string | undefined): CaCertStatus {
    this.shell = value;
    this.commit();
    return this.current;
  }

  /** 设置热更新：生效值变化才重启 worker（worker env 是 fork 时的快照） */
  async setCustomPath(path: string): Promise<CaCertStatus> {
    this.setting = path.trim();
    if (this.commit()) await this.restartWorker();
    return this.current;
  }

  private resolve(): CaCertStatus {
    return resolveExtraCaCert({
      inherited: this.inherited,
      setting: this.setting,
      shell: this.shell,
      check: this.check,
    });
  }

  private commit(): boolean {
    const before = this.env[CA_CERT_ENV];
    this.current = this.resolve();
    if (this.current.source === 'env') return false;
    if (this.current.path) this.env[CA_CERT_ENV] = this.current.path;
    else delete this.env[CA_CERT_ENV];
    return this.env[CA_CERT_ENV] !== before;
  }
}

let instance: CaCertConfig | null = null;

export function getCaCertConfig(): CaCertConfig {
  instance ??= new CaCertConfig(process.env, restartAgentWorker);
  return instance;
}
