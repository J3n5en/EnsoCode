import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../bots/files';

/** 旧版单秘书的数据迁移成的秘书：目录就是 userData/secretary 本身 */
export const DEFAULT_SECRETARY_ID = 'default';
export const MAX_SECRETARIES = 8;
export const DEFAULT_MAX_RUNNING_TOTAL = 10;

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const REGISTRY_FILE = 'secretaries.json';
const MEMBERS_DIR = 'members';

export interface SecretaryEntry {
  id: string;
  createdAt: number;
  order: number;
}

export interface SecretaryRegistryFile {
  version: 1;
  secretaries: SecretaryEntry[];
  maxRunningTotal?: number;
}

export function isSecretaryId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

/** 目录只由 id 推导，不落盘：登记文件被改坏也指不到秘书目录以外 */
export function secretaryDirOf(root: string, id: string): string {
  if (!isSecretaryId(id)) throw new Error(`invalid secretary id: ${String(id)}`);
  return id === DEFAULT_SECRETARY_ID ? root : join(root, MEMBERS_DIR, id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 结构不对返回 null（当作损坏）；单条坏的跳过 */
export function parseRegistryFile(raw: unknown): SecretaryRegistryFile | null {
  if (!isRecord(raw) || !Array.isArray(raw.secretaries)) return null;
  const seen = new Set<string>();
  const secretaries: SecretaryEntry[] = [];
  for (const item of raw.secretaries) {
    if (!isRecord(item) || !isSecretaryId(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    secretaries.push({
      id: item.id,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
      order: typeof item.order === 'number' ? item.order : secretaries.length,
    });
  }
  const total = raw.maxRunningTotal;
  return {
    version: 1,
    secretaries: secretaries.sort((a, b) => a.order - b.order),
    ...(typeof total === 'number' && Number.isInteger(total) && total >= 1 && total <= 50
      ? { maxRunningTotal: total }
      : {}),
  };
}

export interface SecretaryRegistryPorts {
  now(): number;
  /** 新秘书 id 的随机部分 */
  randomId(): string;
}

/**
 * userData/secretary/secretaries.json：有哪些秘书、顺序与合计上限。
 * 文件不存在时合成只有 default 的一份，新建第二个秘书时才落盘，单秘书用户的磁盘不变。
 */
export class SecretaryRegistry {
  constructor(
    private readonly root: string,
    private readonly ports: SecretaryRegistryPorts
  ) {}

  list(): SecretaryEntry[] {
    return this.read().secretaries;
  }

  has(id: string): boolean {
    return this.list().some((entry) => entry.id === id);
  }

  dir(id: string): string {
    return secretaryDirOf(this.root, id);
  }

  maxRunningTotal(): number {
    return this.read().maxRunningTotal ?? DEFAULT_MAX_RUNNING_TOTAL;
  }

  create(): SecretaryEntry {
    const file = this.read();
    if (file.secretaries.length >= MAX_SECRETARIES) throw new Error('secretary limit reached');
    let id = '';
    for (let attempt = 0; attempt < 20 && (!id || this.taken(file, id)); attempt += 1) {
      id = `s-${this.ports
        .randomId()
        .toLowerCase()
        .replace(/[^a-z0-9]/gu, '')
        .slice(0, 8)}`;
    }
    if (!isSecretaryId(id) || this.taken(file, id)) throw new Error('secretary id unavailable');
    const order = file.secretaries.reduce((max, entry) => Math.max(max, entry.order + 1), 0);
    const entry: SecretaryEntry = { id, createdAt: this.ports.now(), order };
    mkdirSync(this.dir(id), { recursive: true });
    this.write({ ...file, secretaries: [...file.secretaries, entry] });
    return entry;
  }

  remove(id: string): void {
    const file = this.read();
    this.write({ ...file, secretaries: file.secretaries.filter((entry) => entry.id !== id) });
  }

  private taken(file: SecretaryRegistryFile, id: string): boolean {
    return (
      file.secretaries.some((entry) => entry.id === id) ||
      existsSync(join(this.root, MEMBERS_DIR, id))
    );
  }

  private read(): SecretaryRegistryFile {
    const path = join(this.root, REGISTRY_FILE);
    if (!existsSync(path)) {
      return {
        version: 1,
        secretaries: [{ id: DEFAULT_SECRETARY_ID, createdAt: 0, order: 0 }],
      };
    }
    const parsed = parseRegistryFile(readJson(path));
    if (parsed) return parsed;
    return this.rebuild(path);
  }

  /** 登记文件坏了：先备份，再按目录重建，宁可多认一个也不丢 */
  private rebuild(path: string): SecretaryRegistryFile {
    try {
      renameSync(path, `${path}.bad-${this.ports.now()}`);
    } catch {
      // 备份失败也照样重建：重建结果会覆盖坏文件
    }
    const secretaries: SecretaryEntry[] = [];
    const legacy = ['profile.json', 'dispatch.json', 'contact.json'].some((name) =>
      existsSync(join(this.root, name))
    );
    if (legacy) secretaries.push({ id: DEFAULT_SECRETARY_ID, createdAt: 0, order: 0 });
    const members = join(this.root, MEMBERS_DIR);
    let names: string[] = [];
    try {
      names = readdirSync(members).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!isSecretaryId(name) || name === DEFAULT_SECRETARY_ID) continue;
      try {
        if (!statSync(join(members, name)).isDirectory()) continue;
      } catch {
        continue;
      }
      secretaries.push({ id: name, createdAt: 0, order: secretaries.length });
    }
    const file: SecretaryRegistryFile = { version: 1, secretaries };
    this.write(file);
    return file;
  }

  private write(file: SecretaryRegistryFile): void {
    mkdirSync(this.root, { recursive: true });
    writeJsonAtomic(join(this.root, REGISTRY_FILE), file);
  }
}
