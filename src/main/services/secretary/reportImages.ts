import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isMediaId } from '@shared/bots/sendImage';
import { SECRETARY_REPORTS_REL } from '@shared/resources';
import { extractReportImagePaths } from '@shared/secretary/doneReport';
import {
  IMAGE_VIEW_MAX_BYTES,
  inImageViewScope,
  resolveRoots,
  systemImageRoots,
} from '@shared/secretary/imageView';
import type { SecretaryReportImage, SecretaryStoredReport } from '@shared/types/secretary';
import { storeMedia } from '../bots/media';

/**
 * 已完成报告的截图副本：userData/secretary-reports/<conversationId>/<sha256>.<ext> 加 report.json。
 * 截图多在 /tmp，重启或系统清理后就没了，所以会话报完成时复制一份。
 * 截图从完成时起留 7 天：启动扫一次、之后每天扫一次；删会话整目录删；报告文字随会话保留。
 */
export const REPORT_IMAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const REPORT_IMAGE_MAX_COUNT = 20;
export const REPORT_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024;
/** 汇报里点名的路径再多也只记这么多条，report.json 不随汇报无限长 */
const REPORT_IMAGE_MAX_ENTRIES = 40;
const REPORT_TEXT_MAX_CHARS = 50_000;
const REPORT_FILE = 'report.json';
const DAY_MS = 24 * 60 * 60 * 1000;

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function secretaryReportsRoot(userData: string): string {
  return path.join(userData, ...SECRETARY_REPORTS_REL.split('/'));
}

/** 只从系统临时目录和会话自己的 worktree 根复制 */
export function reportImageRoots(worktree: string | undefined): string[] {
  return [...systemImageRoots(), ...(worktree ? [worktree] : [])];
}

export interface SecretaryReportStoreDeps {
  root: string;
  /** 这个会话允许复制截图的根目录 */
  roots(conversationId: string): string[];
  now?(): number;
  log?(message: string): void;
  retentionMs?: number;
  maxBytes?: number;
  totalBytes?: number;
}

export interface ReportSweepStats {
  freed: number;
  removed: number;
  skipped: number;
  failed: number;
}

function parseImage(value: unknown): SecretaryReportImage | null {
  if (!value || typeof value !== 'object') return null;
  const image = value as Record<string, unknown>;
  if (typeof image.label !== 'string') return null;
  if (typeof image.name === 'string' && isMediaId(image.name))
    return { label: image.label, name: image.name };
  return image.missing === true ? { label: image.label, missing: true } : null;
}

function parseReport(raw: string): SecretaryStoredReport | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (typeof data.at !== 'number' || typeof data.text !== 'string') return null;
  const images = (Array.isArray(data.images) ? data.images : [])
    .map(parseImage)
    .filter((image): image is SecretaryReportImage => image !== null);
  const gone =
    data.imagesGone === 'expired' || data.imagesGone === 'cleared' ? data.imagesGone : null;
  const goneAt = gone && typeof data.imagesGoneAt === 'number' ? data.imagesGoneAt : null;
  return {
    at: data.at,
    text: data.text,
    images,
    ...(gone ? { imagesGone: gone } : {}),
    ...(goneAt !== null ? { imagesGoneAt: goneAt } : {}),
  };
}

function mediaFiles(dir: string): { name: string; file: string; size: number; mtimeMs: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!isMediaId(name)) continue;
    const file = path.join(dir, name);
    try {
      const info = statSync(file);
      if (info.isFile()) files.push({ name, file, size: info.size, mtimeMs: info.mtimeMs });
    } catch {}
  }
  return files;
}

export class SecretaryReportStore {
  constructor(private readonly deps: SecretaryReportStoreDeps) {}

  dir(conversationId: string): string | null {
    return CONVERSATION_ID.test(conversationId) ? path.join(this.deps.root, conversationId) : null;
  }

  /** 会话报完成：存下汇报正文，复制里面点名的截图；同一会话再次完成就换成新的一份 */
  async archive(
    conversationId: string,
    at: number,
    text: string
  ): Promise<SecretaryStoredReport | null> {
    const dir = this.dir(conversationId);
    if (!dir) return null;
    try {
      const roots = resolveRoots(this.deps.roots(conversationId));
      const images: SecretaryReportImage[] = [];
      let stored = 0;
      let total = 0;
      for (const source of extractReportImagePaths(text).slice(0, REPORT_IMAGE_MAX_ENTRIES)) {
        const label = path.basename(source);
        const copied =
          stored < REPORT_IMAGE_MAX_COUNT ? await this.copy(dir, source, roots, total) : null;
        if (!copied) {
          images.push({ label, missing: true });
          continue;
        }
        if (images.some((image) => 'name' in image && image.name === copied.name)) continue;
        stored += 1;
        total += copied.size;
        images.push({ label, name: copied.name });
      }
      const report: SecretaryStoredReport = {
        at,
        text: text.length > REPORT_TEXT_MAX_CHARS ? text.slice(-REPORT_TEXT_MAX_CHARS) : text,
        images,
      };
      this.write(dir, report);
      const keep = new Set(images.flatMap((image) => ('name' in image ? [image.name] : [])));
      for (const file of mediaFiles(dir)) if (!keep.has(file.name)) this.unlink(file.file);
      return report;
    } catch (error) {
      this.log(`archive ${conversationId} failed: ${String(error)}`);
      return null;
    }
  }

  private async copy(
    dir: string,
    source: string,
    roots: readonly string[],
    total: number
  ): Promise<{ name: string; size: number } | null> {
    if (!path.isAbsolute(source)) return null;
    let resolved: string;
    try {
      resolved = await realpath(source);
    } catch {
      return null;
    }
    if (!inImageViewScope(resolved, roots)) return null;
    const max = this.deps.maxBytes ?? IMAGE_VIEW_MAX_BYTES;
    try {
      const info = await stat(resolved);
      if (!info.isFile() || info.size > max) return null;
      if (total + info.size > (this.deps.totalBytes ?? REPORT_IMAGE_TOTAL_BYTES)) return null;
      const result = storeMedia(dir, await readFile(resolved), {
        compress: () => null,
        fileMax: max,
        quota: Number.POSITIVE_INFINITY,
      });
      return result.ok ? { name: result.mediaId, size: info.size } : null;
    } catch {
      return null;
    }
  }

  read(conversationId: string): SecretaryStoredReport | null {
    const dir = this.dir(conversationId);
    if (!dir) return null;
    try {
      return parseReport(readFileSync(path.join(dir, REPORT_FILE), 'utf8'));
    } catch {
      return null;
    }
  }

  /** 图片协议取图：只认合法会话 id 与内容哈希文件名 */
  imageFile(conversationId: string, name: string): string | null {
    const dir = this.dir(conversationId);
    return dir && isMediaId(name) ? path.join(dir, name) : null;
  }

  /**
   * 给结果视图：逐张看副本还在不在。已删的按报告标记或过没过保留期算过期 / 清理；
   * 保留期内无故没了的算无法显示
   */
  view(conversationId: string): SecretaryStoredReport | null {
    const report = this.read(conversationId);
    const dir = this.dir(conversationId);
    if (!report || !dir) return report;
    const retention = this.retention();
    const expiresAt = report.at + retention;
    const reason = report.imagesGone ?? (this.now() > expiresAt ? 'expired' : null);
    const images = report.images.map((image): SecretaryReportImage => {
      if (!('name' in image) || existsSync(path.join(dir, image.name))) return image;
      return reason ? { ...image, gone: reason } : { label: image.label, missing: true };
    });
    const goneAt = images.some((image) => 'gone' in image)
      ? (report.imagesGoneAt ?? (reason === 'expired' ? expiresAt : undefined))
      : undefined;
    return {
      ...report,
      images,
      retentionDays: Math.round(retention / DAY_MS),
      ...(goneAt !== undefined ? { imagesGoneAt: goneAt } : {}),
    };
  }

  /** 过了保留期的截图删掉，报告标成过期；没有报告的孤儿截图按修改时间算 */
  sweep(): Promise<ReportSweepStats> {
    const retention = this.retention();
    const now = this.now();
    return this.eachDir((report) => {
      if (!report) return { drop: (file) => now - file.mtimeMs > retention, mark: false };
      const due = now - report.at > retention;
      return { drop: () => due, mark: due };
    }, 'expired');
  }

  /** 资源页「清理」：删掉全部截图，报告文字保留 */
  clear(): Promise<ReportSweepStats> {
    return this.eachDir(() => ({ drop: () => true, mark: true }), 'cleared');
  }

  remove(conversationId: string): void {
    const dir = this.dir(conversationId);
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      this.log(`remove ${conversationId} failed: ${String(error)}`);
    }
  }

  private async eachDir(
    pick: (report: SecretaryStoredReport | null) => {
      drop: (file: { mtimeMs: number }) => boolean;
      mark: boolean;
    },
    gone: 'expired' | 'cleared'
  ): Promise<ReportSweepStats> {
    const stats: ReportSweepStats = { freed: 0, removed: 0, skipped: 0, failed: 0 };
    let ids: string[];
    try {
      ids = readdirSync(this.deps.root).filter((name) => CONVERSATION_ID.test(name));
    } catch {
      return stats;
    }
    for (const id of ids) {
      const dir = path.join(this.deps.root, id);
      const report = this.read(id);
      const { drop, mark } = pick(report);
      let removed = 0;
      for (const file of mediaFiles(dir)) {
        if (!drop(file)) stats.skipped += 1;
        else if (this.unlink(file.file)) {
          removed += 1;
          stats.freed += file.size;
        } else stats.failed += 1;
      }
      stats.removed += removed;
      const had = report?.images.some((image) => 'name' in image);
      if (report && had && mark && !report.imagesGone && mediaFiles(dir).length === 0) {
        try {
          this.write(dir, { ...report, imagesGone: gone, imagesGoneAt: this.now() });
        } catch (error) {
          this.log(`mark ${id} failed: ${String(error)}`);
        }
      }
      if (removed) this.log(`${gone} ${removed} screenshot(s) of ${id}`);
    }
    return stats;
  }

  private write(dir: string, report: SecretaryStoredReport): void {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, REPORT_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(report));
    renameSync(tmp, file);
  }

  private unlink(file: string): boolean {
    try {
      unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private retention(): number {
    return this.deps.retentionMs ?? REPORT_IMAGE_RETENTION_MS;
  }

  private log(message: string): void {
    (this.deps.log ?? ((text: string) => console.warn(text)))(`[secretary-reports] ${message}`);
  }
}

let instance: SecretaryReportStore | null = null;

export function setSecretaryReportStore(store: SecretaryReportStore | null): void {
  instance = store;
}

export function getSecretaryReportStore(): SecretaryReportStore | null {
  return instance;
}
