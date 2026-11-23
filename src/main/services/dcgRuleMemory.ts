import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  activeDcgExemptions,
  addDcgExemption,
  type DcgRuleMemory,
  dcgRuleState,
  emptyDcgRuleMemory,
  listActiveDcgExemptions,
  parseDcgRuleMemory,
  recordDcgRuleAllow,
  removeDcgExemption,
} from '@shared/dcgRuleMemory';
import type { DcgRuleExemption, DcgRuleState } from '@shared/types/dcg';
import { platformCodec, type SecureCodec } from './secureFile';

// 放在 dcg/ 之外，且必须经 OS 钥匙串加密存储（dcg-rules.bin），防止模型或外部脚本篡改磁盘给自己加豁免
export const dcgRuleMemoryFile = (root: string): string => path.join(root, 'dcg-rules.bin');
const legacyPlainFile = (root: string): string => path.join(root, 'dcg-rules.json');

export interface DcgRuleMemoryStore {
  ready(): Promise<void>;
  readState(ruleId: string, version: string): Promise<DcgRuleState>;
  recordAllow(ruleId: string, version: string): Promise<DcgRuleState>;
  exempt(ruleId: string, version: string): Promise<DcgRuleState>;
  revoke(ruleId: string, version: string): Promise<DcgRuleExemption[]>;
  listExemptions(version: string): Promise<DcgRuleExemption[]>;
  activeRules(version: string): string[];
  clear(): Promise<void>;
}

/**
 * Fail-closed 加密存储：
 * - 钥匙串可用：加密写 dcg-rules.bin；读取时解密失败（如被外部篡改或覆盖成明文 JSON）一律丢弃视为空表。
 * - 钥匙串不可用：不落明文磁盘文件，仅在当前 Main 进程内存维护，避免被 bash/write 伪造豁免。
 */
export function createDcgRuleMemoryStore(
  root: string,
  codec: SecureCodec = platformCodec
): DcgRuleMemoryStore {
  let memory: DcgRuleMemory = emptyDcgRuleMemory();
  let secure = false;
  let dirty = false;
  let hydrating: Promise<void> | null = null;
  let queue: Promise<void> = Promise.resolve();
  const file = dcgRuleMemoryFile(root);

  const hydrate = async (): Promise<void> => {
    try {
      secure = await codec.available();
    } catch {
      secure = false;
    }
    if (!secure) return;
    let raw: Buffer;
    try {
      raw = await readFile(file);
    } catch {
      return;
    }
    if (dirty) return;
    try {
      const { text, reEncrypt } = await codec.decrypt(raw);
      const parsed = parseDcgRuleMemory(JSON.parse(text));
      if (dirty) return;
      memory = parsed;
      if (reEncrypt) void persist(parsed);
    } catch {
      // 密文损坏或被外部篡改：fail-closed 视为空表
      memory = emptyDcgRuleMemory();
    }
  };

  const ready = (): Promise<void> => {
    hydrating ??= hydrate();
    return hydrating;
  };

  const persist = async (next: DcgRuleMemory): Promise<void> => {
    if (!secure) return;
    const encrypted = await codec.encrypt(JSON.stringify(next));
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, encrypted, { mode: 0o600 });
    await rename(tmp, file);
    if (process.platform !== 'win32') {
      await chmod(file, 0o600).catch(() => {});
    }
  };

  const mutate = <T>(
    fn: (current: DcgRuleMemory) => { next: DcgRuleMemory; out: T }
  ): Promise<T> => {
    const run = queue.then(async () => {
      await ready();
      dirty = true;
      const { next, out } = fn(memory);
      memory = next;
      await persist(next);
      return out;
    });
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  return {
    ready,
    async readState(ruleId, version) {
      await ready();
      return dcgRuleState(memory, ruleId, version);
    },
    recordAllow(ruleId, version) {
      return mutate((current) => {
        const next = recordDcgRuleAllow(current, ruleId);
        return { next, out: dcgRuleState(next, ruleId, version) };
      });
    },
    exempt(ruleId, version) {
      return mutate((current) => {
        const next = addDcgExemption(current, ruleId, version, Date.now());
        return { next, out: dcgRuleState(next, ruleId, version) };
      });
    },
    revoke(ruleId, version) {
      return mutate((current) => {
        const next = removeDcgExemption(current, ruleId);
        return { next, out: listActiveDcgExemptions(next, version) };
      });
    },
    async listExemptions(version) {
      await ready();
      return listActiveDcgExemptions(memory, version);
    },
    activeRules(version) {
      if (!hydrating) void ready();
      return activeDcgExemptions(memory, version);
    },
    clear() {
      const run = queue.then(async () => {
        await ready();
        dirty = true;
        memory = emptyDcgRuleMemory();
        await rm(file, { force: true });
        await rm(legacyPlainFile(root), { force: true });
      });
      queue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };
}

const stores = new Map<string, DcgRuleMemoryStore>();

function storeFor(root: string): DcgRuleMemoryStore {
  let store = stores.get(root);
  if (!store) {
    store = createDcgRuleMemoryStore(root);
    stores.set(root, store);
  }
  return store;
}

export const ensureDcgRuleMemoryReady = (root: string): Promise<void> => storeFor(root).ready();

export const readDcgRuleState = (
  root: string,
  ruleId: string,
  version: string
): Promise<DcgRuleState> => storeFor(root).readState(ruleId, version);

export const recordDcgAllow = (
  root: string,
  ruleId: string,
  version: string
): Promise<DcgRuleState> => storeFor(root).recordAllow(ruleId, version);

export const exemptDcgRule = (
  root: string,
  ruleId: string,
  version: string
): Promise<DcgRuleState> => storeFor(root).exempt(ruleId, version);

export const revokeDcgExemption = (
  root: string,
  ruleId: string,
  version: string
): Promise<DcgRuleExemption[]> => storeFor(root).revoke(ruleId, version);

export const listDcgExemptions = (root: string, version: string): Promise<DcgRuleExemption[]> =>
  storeFor(root).listExemptions(version);

export const activeDcgExemptRules = (root: string, version: string): string[] =>
  storeFor(root).activeRules(version);

/** 清除豁免与放过计数 */
export async function clearDcgRuleMemory(root: string): Promise<void> {
  await storeFor(root).clear();
}
