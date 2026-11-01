import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 1024 * 1024;
const ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;

/** 侧栏页面状态，替代 localStorage；每插件合计不超过 1MB */
export class ViewStateStore {
  constructor(private readonly root: string) {}

  get(pluginId: string): Record<string, string> {
    if (!ID.test(pluginId)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.path(pluginId), 'utf8'));
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw))
        if (typeof value === 'string') out[key] = value;
      return out;
    } catch {
      return {};
    }
  }

  set(pluginId: string, patch: Record<string, string | null>): { ok: boolean; error?: string } {
    if (!ID.test(pluginId)) return { ok: false, error: '插件 id 不合法' };
    const next = this.get(pluginId);
    for (const [key, value] of Object.entries(patch)) {
      if (key.length === 0 || key.length > 256 || key.includes('\0'))
        return { ok: false, error: '状态键不合法' };
      if (value === null) delete next[key];
      else if (typeof value !== 'string') return { ok: false, error: '状态值必须是字符串' };
      else next[key] = value;
    }
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > MAX_BYTES) return { ok: false, error: '侧栏状态超过 1MB' };
    if (Object.keys(next).length === 0) {
      rmSync(this.path(pluginId), { force: true });
      return { ok: true };
    }
    mkdirSync(join(this.root, 'view-state'), { recursive: true });
    const target = this.path(pluginId);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, target);
    return { ok: true };
  }

  remove(pluginId: string): void {
    if (!ID.test(pluginId)) return;
    rmSync(this.path(pluginId), { force: true });
  }

  private path(pluginId: string): string {
    return join(this.root, 'view-state', `${pluginId}.json`);
  }
}
