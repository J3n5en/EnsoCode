import { readdirSync, rmdirSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isMediaId } from '@shared/bots/sendImage';
import { SECRETARY_IMAGES_REL } from '@shared/resources';
import type { InboundImageRejection } from '@shared/secretary/inboundImages';
import { storeMedia } from '../bots/media';

/**
 * 用户发给秘书的图片：userData/bot-chats/secretary-images/<conversationId>/<sha256>.<ext>。
 * bot-chats 已在 image_view / contact_send_file 白名单里；同图按内容哈希只存一份。
 * 清理按会话：删会话即删；启动扫一次，未被消息引用且超过 7 天的删；
 * 单会话超过 200MB 时从最旧的未引用文件删起。清理失败只记日志。
 */
export const INBOUND_IMAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const INBOUND_IMAGE_DIR_QUOTA = 200 * 1024 * 1024;
/** 刚存下的图，引用它的消息可能还没写进会话 jsonl：这段时间内一律不删 */
const PENDING_GRACE_MS = 10 * 60 * 1000;

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function secretaryImagesRoot(userData: string): string {
  return path.join(userData, ...SECRETARY_IMAGES_REL.split('/'));
}

export type SavedInboundImage =
  | { ok: true; path: string; size: number }
  | { ok: false; reason: InboundImageRejection };

/** 判断某个文件名是否仍被该会话的消息引用；null 表示读不到，不能据此删除 */
export type ImageReferences = (name: string) => boolean;

export interface SecretaryImageStoreDeps {
  root: string;
  references(conversationId: string): Promise<ImageReferences | null>;
  now?(): number;
  log?(message: string): void;
  retentionMs?: number;
  quota?: number;
}

interface ImageFile {
  name: string;
  file: string;
  size: number;
  mtimeMs: number;
}

function listImages(dir: string): ImageFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: ImageFile[] = [];
  for (const name of names) {
    if (!isMediaId(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = statSync(file);
      if (stat.isFile()) files.push({ name, file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  return files;
}

export interface PruneOptions {
  now: number;
  referenced: ImageReferences;
  /** 只按体积清理，不按天数 */
  quotaOnly?: boolean;
  retentionMs?: number;
  quota?: number;
}

export interface PruneResult {
  removed: string[];
  freed: number;
  /** 留下的文件数（被引用、未过期或删除失败） */
  kept: number;
  failed: number;
}

/** 一个会话目录的清理；仍被引用的文件永远不删 */
export function pruneConversationImages(dir: string, options: PruneOptions): PruneResult {
  const retention = options.retentionMs ?? INBOUND_IMAGE_RETENTION_MS;
  const quota = options.quota ?? INBOUND_IMAGE_DIR_QUOTA;
  const removable = (image: ImageFile) =>
    options.now - image.mtimeMs > PENDING_GRACE_MS && !options.referenced(image.name);
  const removed: string[] = [];
  let freed = 0;
  let failed = 0;
  const drop = (image: ImageFile): boolean => {
    try {
      unlinkSync(image.file);
      removed.push(image.name);
      freed += image.size;
      return true;
    } catch {
      failed += 1;
      return false;
    }
  };
  let images = listImages(dir);
  if (!options.quotaOnly) {
    images = images.filter(
      (image) => !(removable(image) && options.now - image.mtimeMs > retention && drop(image))
    );
  }
  let total = images.reduce((sum, image) => sum + image.size, 0);
  let kept = images.length;
  if (total > quota) {
    const oldest = images.filter(removable).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const image of oldest) {
      if (total <= quota) break;
      if (drop(image)) {
        total -= image.size;
        kept -= 1;
      }
    }
  }
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {}
  return { removed, freed, kept, failed };
}

export interface SweepStats {
  freed: number;
  removed: number;
  skipped: number;
  failed: number;
}

function dirUsage(dir: string): number {
  return listImages(dir).reduce((sum, image) => sum + image.size, 0);
}

export class SecretaryImageStore {
  constructor(private readonly deps: SecretaryImageStoreDeps) {}

  dir(conversationId: string): string | null {
    return CONVERSATION_ID.test(conversationId) ? path.join(this.deps.root, conversationId) : null;
  }

  /** 一条消息里的图片一起存：按文件头判格式、单张 ≤10MB；同图再存只刷新时间，不存第二份 */
  saveAll(conversationId: string, images: readonly Buffer[]): SavedInboundImage[] {
    const dir = this.dir(conversationId);
    if (!dir) return images.map(() => ({ ok: false, reason: 'unavailable' }));
    const saved = images.map((data) => this.save(dir, data));
    if (saved.some((item) => item.ok)) this.enforceQuota(conversationId, dir);
    return saved;
  }

  private save(dir: string, data: Buffer): SavedInboundImage {
    try {
      const stored = storeMedia(dir, data, {
        compress: () => null,
        quota: Number.POSITIVE_INFINITY,
      });
      if (!stored.ok)
        return { ok: false, reason: stored.error === 'not-image' ? 'not-image' : 'too-large' };
      const file = path.join(dir, stored.mediaId);
      const now = new Date(this.now());
      utimesSync(file, now, now);
      return { ok: true, path: file, size: statSync(file).size };
    } catch (error) {
      this.log(`save failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, reason: 'unavailable' };
    }
  }

  /** 删除会话：整目录删掉 */
  remove(conversationId: string): void {
    const dir = this.dir(conversationId);
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      this.log(`remove ${conversationId} failed: ${String(error)}`);
    }
  }

  /** 启动时与设置页「清理」共用：扫全部会话目录 */
  async sweep(): Promise<SweepStats> {
    const stats: SweepStats = { freed: 0, removed: 0, skipped: 0, failed: 0 };
    let ids: string[];
    try {
      ids = readdirSync(this.deps.root).filter((name) => CONVERSATION_ID.test(name));
    } catch {
      return stats;
    }
    for (const id of ids) {
      const dir = path.join(this.deps.root, id);
      try {
        const referenced = await this.deps.references(id);
        if (!referenced) {
          stats.skipped += listImages(dir).length;
          continue;
        }
        const result = pruneConversationImages(dir, {
          now: this.now(),
          referenced,
          ...this.limits(),
        });
        stats.freed += result.freed;
        stats.removed += result.removed.length;
        stats.skipped += result.kept;
        stats.failed += result.failed;
        if (result.removed.length) this.log(`swept ${result.removed.length} file(s) from ${id}`);
      } catch (error) {
        stats.failed += 1;
        this.log(`sweep ${id} failed: ${String(error)}`);
      }
    }
    return stats;
  }

  private enforceQuota(conversationId: string, dir: string): void {
    if (dirUsage(dir) <= (this.deps.quota ?? INBOUND_IMAGE_DIR_QUOTA)) return;
    void this.deps
      .references(conversationId)
      .then((referenced) => {
        if (!referenced) return;
        pruneConversationImages(dir, {
          now: this.now(),
          referenced,
          quotaOnly: true,
          ...this.limits(),
        });
      })
      .catch((error: unknown) => this.log(`quota ${conversationId} failed: ${String(error)}`));
  }

  private limits(): { retentionMs?: number; quota?: number } {
    return {
      ...(this.deps.retentionMs !== undefined ? { retentionMs: this.deps.retentionMs } : {}),
      ...(this.deps.quota !== undefined ? { quota: this.deps.quota } : {}),
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(message: string): void {
    (this.deps.log ?? ((text: string) => console.warn(text)))(`[secretary-images] ${message}`);
  }
}

/**
 * 会话 jsonl 里还写着这个文件名就算被引用。会话已删或还没有 jsonl：没有引用；
 * 文件在但读不了：返回 null，这次不清理。
 */
export async function sessionFileReferences(
  sessionFile: string | undefined
): Promise<ImageReferences | null> {
  if (!sessionFile) return () => false;
  try {
    const text = await readFile(sessionFile, 'utf8');
    return (name) => text.includes(name);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? () => false : null;
  }
}

let instance: SecretaryImageStore | null = null;

export function setSecretaryImageStore(store: SecretaryImageStore | null): void {
  instance = store;
}

export function getSecretaryImageStore(): SecretaryImageStore | null {
  return instance;
}
