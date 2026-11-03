import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginArtifactInfo } from '@shared/extensionPlugins/protocol';
import { pluginError } from './process';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_COUNT = 200;

interface Entry {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
}

/** 产出文件落在 root/artifacts/<pluginId>/；index.json 与文件都是 0600 */
export class ArtifactStore {
  private readonly byPlugin = new Map<string, Entry[]>();
  private loaded = false;

  constructor(private readonly root: string) {}

  async write(
    pluginId: string,
    input: { name?: unknown; text?: unknown; base64?: unknown; mime?: unknown }
  ): Promise<PluginArtifactInfo> {
    this.ensure();
    const name = fileName(input.name);
    const hasText = typeof input.text === 'string';
    const hasBase64 = typeof input.base64 === 'string';
    if (hasText === hasBase64) throw pluginError('INVALID_ARGS', '需要 text 或 base64 之一');
    const body = hasText
      ? Buffer.from(input.text as string, 'utf8')
      : Buffer.from(input.base64 as string, 'base64');
    const fallback = hasText ? 'text/plain; charset=utf-8' : 'application/octet-stream';
    const mime = typeof input.mime === 'string' && input.mime.length > 0 ? input.mime : fallback;
    if (mime.length > 200 || /[\r\n\0]/.test(mime))
      throw pluginError('INVALID_ARGS', 'mime 不合法');
    if (body.length > MAX_BYTES) throw pluginError('TOO_LARGE', '产出超过 50MB');
    const list = this.entries(pluginId);
    const entry: Entry = {
      id: randomUUID(),
      name,
      mime,
      size: body.length,
      createdAt: Date.now(),
    };
    const dir = this.dir(pluginId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${entry.id}.bin`);
    await writeFile(file, body, { mode: 0o600 });
    if (this.byPlugin.get(pluginId) !== list) {
      rmSync(file, { force: true });
      throw pluginError('PLUGIN_REMOVED', '插件已卸载');
    }
    list.push(entry);
    while (list.length > MAX_COUNT) {
      const oldest = list.shift();
      if (oldest) this.unlink(pluginId, oldest.id);
    }
    this.save(pluginId, list);
    return this.toInfo(pluginId, entry);
  }

  list(pluginId?: string): PluginArtifactInfo[] {
    this.ensure();
    const ids = pluginId ? [pluginId] : [...this.byPlugin.keys()].sort();
    return ids.flatMap((id) =>
      (this.byPlugin.get(id) ?? []).map((entry) => this.toInfo(id, entry))
    );
  }

  info(id: string): PluginArtifactInfo | null {
    this.ensure();
    for (const [pluginId, list] of this.byPlugin) {
      const entry = list.find((item) => item.id === id);
      if (entry) return this.toInfo(pluginId, entry);
    }
    return null;
  }

  path(id: string): string | null {
    const found = this.info(id);
    if (!found) return null;
    const file = join(this.dir(found.pluginId), `${id}.bin`);
    try {
      return statSync(file).isFile() ? file : null;
    } catch {
      return null;
    }
  }

  delete(id: string): boolean {
    this.ensure();
    for (const [pluginId, list] of this.byPlugin) {
      const index = list.findIndex((entry) => entry.id === id);
      if (index < 0) continue;
      list.splice(index, 1);
      this.unlink(pluginId, id);
      this.save(pluginId, list);
      return true;
    }
    return false;
  }

  removePlugin(pluginId: string): void {
    this.byPlugin.delete(pluginId);
    rmSync(this.dir(pluginId), { recursive: true, force: true });
  }

  private toInfo(pluginId: string, entry: Entry): PluginArtifactInfo {
    return {
      id: entry.id,
      pluginId,
      name: entry.name,
      mime: entry.mime,
      size: entry.size,
      createdAt: entry.createdAt,
    };
  }

  private dir(pluginId: string): string {
    return join(this.root, 'artifacts', pluginId);
  }

  private entries(pluginId: string): Entry[] {
    const existing = this.byPlugin.get(pluginId);
    if (existing) return existing;
    const created: Entry[] = [];
    this.byPlugin.set(pluginId, created);
    return created;
  }

  private save(pluginId: string, list: Entry[]): void {
    const dir = this.dir(pluginId);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'index.json');
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
    renameSync(tmp, target);
  }

  private unlink(pluginId: string, id: string): void {
    rmSync(join(this.dir(pluginId), `${id}.bin`), { force: true });
  }

  private ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    let names: string[] = [];
    try {
      names = readdirSync(join(this.root, 'artifacts'));
    } catch {
      return;
    }
    for (const pluginId of names) {
      if (pluginId.includes('..') || pluginId.includes('/') || pluginId.includes('\\')) continue;
      try {
        const raw = JSON.parse(
          readFileSync(join(this.root, 'artifacts', pluginId, 'index.json'), 'utf8')
        );
        if (!Array.isArray(raw)) continue;
        const list: Entry[] = [];
        for (const item of raw) {
          if (!isEntry(item)) continue;
          list.push(item);
        }
        if (list.length > 0) this.byPlugin.set(pluginId, list);
      } catch {
        // 单个插件的索引坏了不影响其它插件
      }
    }
  }
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Entry;
  return (
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.mime === 'string' &&
    typeof entry.size === 'number' &&
    typeof entry.createdAt === 'number'
  );
}

function fileName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200)
    throw pluginError('INVALID_ARGS', '文件名不合法');
  if (
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name === '.' ||
    name === '..'
  )
    throw pluginError('INVALID_ARGS', '文件名不能包含路径');
  return name;
}
