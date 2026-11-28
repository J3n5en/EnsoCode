import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { app } from '@platform';
import { sniffImage } from '@shared/bots/cardPng';
import { PROJECT_ICON_MAX_BYTES, type ProjectIconInfo } from '@shared/projectIcon';
import type { ProjectKind } from '@shared/types/agent';
import { writeAtomic } from './bots/files';
import { loadProjectIcon } from './projectIconScanner';

const HIT_TTL_MS = 10 * 60_000;
const MISS_TTL_MS = 2 * 60_000;
const NONE_INFO: ProjectIconInfo = { revision: 'none', kind: 'none' };

export interface ProjectIconResult {
  info: ProjectIconInfo;
  data: Buffer | null;
  mimeType: string | null;
}

export interface ProjectIconFile {
  path: string;
  mimeType?: string;
}

interface ProjectLocation {
  canonicalPath: string;
  kind?: ProjectKind;
}

interface HitCache {
  kind: 'hit';
  data: Buffer;
  mimeType: string;
  revision: string;
  sourcePath: string;
  mtimeMs: number;
  servePath: string | null;
  checkedAt: number;
}

interface MissCache {
  kind: 'miss';
  checkedAt: number;
}

const NONE: ProjectIconResult = { info: NONE_INFO, data: null, mimeType: null };

export function safeProjectId(projectId: string): string | null {
  if (typeof projectId !== 'string' || projectId.length === 0) return null;
  if (
    projectId.includes('..') ||
    projectId.includes('/') ||
    projectId.includes('\\') ||
    projectId.includes('\0')
  ) {
    return null;
  }
  const safe = /^[a-zA-Z0-9_-]+$/.test(projectId)
    ? projectId
    : projectId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return /^[a-zA-Z0-9_-]+$/.test(safe) ? safe : null;
}

export function customIconPath(userDataRoot: string, projectId: string): string | null {
  const safe = safeProjectId(projectId);
  if (!safe) return null;
  const root = resolve(userDataRoot, 'projects-icons');
  const file = resolve(root, safe, 'icon.png');
  if (!file.startsWith(root + sep)) return null;
  return file;
}

function revisionOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

function mimeOf(format: 'png' | 'jpeg' | 'webp'): string {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
}

function scansDirectory(kind: ProjectKind | undefined): boolean {
  return kind === undefined || kind === 'local';
}

async function fileMtime(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export class ProjectIconStore {
  private readonly cache = new Map<string, HitCache | MissCache>();
  private lookup: (projectId: string) => ProjectLocation | null = () => null;

  constructor(
    private readonly userDataRoot: string,
    private readonly now: () => number = Date.now
  ) {}

  setProjectLookup(lookup: (projectId: string) => ProjectLocation | null): void {
    this.lookup = lookup;
  }

  async getIcon(
    projectId: string,
    canonicalPath: string,
    projectKind?: ProjectKind
  ): Promise<ProjectIconResult> {
    const custom = await this.readCustom(projectId);
    if (custom) {
      return {
        info: { revision: custom.revision, kind: 'custom' },
        data: custom.data,
        mimeType: custom.mimeType,
      };
    }
    const scanned = await this.scanned(projectId, canonicalPath, projectKind);
    if (!scanned) return NONE;
    return {
      info: { revision: scanned.revision, kind: 'scanned' },
      data: scanned.data,
      mimeType: scanned.mimeType,
    };
  }

  async setCustomIcon(
    projectId: string,
    image: Uint8Array | null
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const file = customIconPath(this.userDataRoot, projectId);
    if (!file) return { ok: false, error: 'invalid-id' };
    if (image === null) {
      try {
        rmSync(file, { force: true });
      } catch {
        return { ok: false, error: 'write-failed' };
      }
      this.cache.delete(projectId);
      return { ok: true };
    }
    if (image.byteLength > PROJECT_ICON_MAX_BYTES) return { ok: false, error: 'too-large' };
    const format = sniffImage(image);
    if (!format) return { ok: false, error: 'unsupported-image' };
    try {
      writeAtomic(file, image);
    } catch {
      return { ok: false, error: 'write-failed' };
    }
    this.cache.delete(projectId);
    return { ok: true };
  }

  removeProjectData(projectId: string): void {
    const file = customIconPath(this.userDataRoot, projectId);
    if (file) rmSync(dirname(file), { recursive: true, force: true });
    const safe = safeProjectId(projectId);
    if (safe) {
      rmSync(join(this.userDataRoot, 'projects-icons', '.scan', `${safe}.png`), { force: true });
    }
    this.cache.delete(projectId);
  }

  async serveIconFile(projectId: string): Promise<ProjectIconFile | null> {
    const custom = await this.readCustom(projectId);
    if (custom) {
      const path = customIconPath(this.userDataRoot, projectId);
      return path ? { path, mimeType: custom.mimeType } : null;
    }
    const project = this.lookup(projectId);
    if (!project) return null;
    const scanned = await this.scanned(projectId, project.canonicalPath, project.kind);
    if (!scanned?.servePath) return null;
    return { path: scanned.servePath, mimeType: scanned.mimeType };
  }

  private async readCustom(
    projectId: string
  ): Promise<{ data: Buffer; mimeType: string; revision: string } | null> {
    const file = customIconPath(this.userDataRoot, projectId);
    if (!file) return null;
    try {
      const data = await readFile(file);
      if (data.byteLength === 0 || data.byteLength > PROJECT_ICON_MAX_BYTES) return null;
      const format = sniffImage(data);
      if (!format) return null;
      return { data, mimeType: mimeOf(format), revision: revisionOf(data) };
    } catch {
      return null;
    }
  }

  private async scanned(
    projectId: string,
    canonicalPath: string,
    projectKind?: ProjectKind
  ): Promise<HitCache | null> {
    if (!scansDirectory(projectKind) || !canonicalPath) return null;
    const now = this.now();
    const cached = this.cache.get(projectId);
    if (cached?.kind === 'miss' && now - cached.checkedAt < MISS_TTL_MS) return null;
    if (cached?.kind === 'hit') {
      const mtime = await fileMtime(cached.sourcePath);
      if (mtime !== null && mtime === cached.mtimeMs && now - cached.checkedAt < HIT_TTL_MS) {
        return cached;
      }
    }
    if (!(await isDirectory(canonicalPath))) {
      this.cache.set(projectId, { kind: 'miss', checkedAt: now });
      return null;
    }
    const loaded = await loadProjectIcon(canonicalPath);
    // 抽不出 PNG 帧的 ICO 协议层画不了，不当命中。
    if (!loaded || loaded.mimeType === 'image/x-icon') {
      this.cache.set(projectId, { kind: 'miss', checkedAt: now });
      return null;
    }
    const servePath = loaded.bytesAreSourceFile
      ? loaded.path
      : this.materialize(projectId, loaded.data);
    const hit: HitCache = {
      kind: 'hit',
      data: loaded.data,
      mimeType: loaded.mimeType,
      revision: revisionOf(loaded.data),
      sourcePath: loaded.path,
      mtimeMs: loaded.mtimeMs,
      servePath,
      checkedAt: now,
    };
    this.cache.set(projectId, hit);
    return hit;
  }

  private materialize(projectId: string, data: Buffer): string | null {
    const safe = safeProjectId(projectId);
    if (!safe) return null;
    const dest = join(this.userDataRoot, 'projects-icons', '.scan', `${safe}.png`);
    try {
      writeAtomic(dest, data);
      return dest;
    } catch {
      return null;
    }
  }
}

let singleton: ProjectIconStore | null = null;

export function getProjectIconStore(): ProjectIconStore {
  singleton ??= new ProjectIconStore(app.getPath('userData'));
  return singleton;
}
