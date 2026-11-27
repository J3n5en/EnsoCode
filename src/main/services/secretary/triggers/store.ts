import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_TRIGGER_PORT,
  parseTriggerPort,
  parseTriggersFile,
} from '@shared/secretary/triggers';
import type { SecretaryTrigger } from '@shared/types/secretary';
import { readJson, writeJsonAtomic } from '../../bots/files';
import { type SecureCodec, SecureJsonFile } from '../../secureFile';

function parseTokenMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === 'string' && typeof value === 'string' && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 单个秘书目录下的触发器持久化：
 * - triggers.json：不含密钥的元数据（原子写）
 * - trigger-tokens.bin：triggerId → token 映射，由 safeStorage 加密保存
 */
export class TriggerStore {
  private readonly tokensFile: SecureJsonFile<Record<string, string>>;

  constructor(
    private readonly dir: string,
    codec?: SecureCodec
  ) {
    this.tokensFile = new SecureJsonFile(
      () => join(this.dir, 'trigger-tokens.bin'),
      () => ({}),
      parseTokenMap,
      codec
    );
  }

  ready(): Promise<void> {
    return this.tokensFile.ready();
  }

  list(): SecretaryTrigger[] {
    return parseTriggersFile(readJson(join(this.dir, 'triggers.json')));
  }

  saveList(triggers: readonly SecretaryTrigger[]): SecretaryTrigger[] {
    const parsed = parseTriggersFile({ version: 1, triggers });
    writeJsonAtomic(join(this.dir, 'triggers.json'), { version: 1, triggers: parsed });
    return parsed;
  }

  getToken(triggerId: string): string | undefined {
    return this.tokensFile.get()[triggerId];
  }

  async setToken(triggerId: string, token: string): Promise<void> {
    await this.tokensFile.ready();
    const next = { ...this.tokensFile.get(), [triggerId]: token };
    await this.tokensFile.set(next);
  }

  async deleteToken(triggerId: string): Promise<void> {
    await this.tokensFile.ready();
    const current = this.tokensFile.get();
    if (!(triggerId in current)) return;
    const { [triggerId]: _removed, ...rest } = current;
    await this.tokensFile.set(rest);
  }
}

export interface TriggerServerConfig {
  version: 1;
  port: number;
}

export interface TriggerServerRuntimeInfo {
  pid: number;
  host: '127.0.0.1';
  port: number;
  startedAt: number;
}

/** userData/secretary/trigger-server.json 与运行时信息文件 */
export class TriggerServerConfigStore {
  constructor(private readonly rootDir: string) {}

  readConfig(): TriggerServerConfig {
    const raw = readJson(join(this.rootDir, 'trigger-server.json'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const port = parseTriggerPort((raw as Record<string, unknown>).port);
      if (port !== null) return { version: 1, port };
    }
    return { version: 1, port: DEFAULT_TRIGGER_PORT };
  }

  savePort(port: number): TriggerServerConfig {
    const validated = parseTriggerPort(port);
    if (validated === null) throw new Error('Invalid trigger server port');
    const next: TriggerServerConfig = { version: 1, port: validated };
    writeJsonAtomic(join(this.rootDir, 'trigger-server.json'), next);
    return next;
  }

  writeRuntime(info: TriggerServerRuntimeInfo): void {
    const target = join(this.rootDir, 'trigger-server.runtime.json');
    writeJsonAtomic(target, info);
    if (process.platform !== 'win32') {
      try {
        chmodSync(target, 0o600);
      } catch {
        // 忽略权限收紧失败，不阻断启动
      }
    }
  }

  clearRuntime(): void {
    try {
      rmSync(join(this.rootDir, 'trigger-server.runtime.json'), { force: true });
    } catch {
      // 忽略清理失败
    }
  }
}
