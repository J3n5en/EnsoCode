import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { conversationCwd } from '@shared/conversationCwd';
import { removeChildRuns } from './childRunCatalog';
import { removePastedTextFiles } from './pastedTextFiles';

export interface RemoveConversationSessionFilesOptions {
  sessionDir: string;
  conversationId: string;
  sessionFile?: string;
  /** scratch 会话的根目录；只删除其中 `<id>` 这一层，非法 id 或越界不删 */
  scratchRoot?: string;
}

/**
 * 删除会话时连带清理磁盘上的 jsonl:
 * - 父会话文件(registry 的 sessionFile,pi SessionManager 命名)
 * - coworker safe journal(`enso-<conversationId>__cw-*`,见 ensoSafeJournal 的命名规则:
 *   child sessionId `<parent>::cw-<id>` 经 sanitize 后 `::` → `__`)
 *
 * 全程 best-effort:文件被占用/缺失/目录不存在都不抛错。
 * sessionFile 必须落在 sessionDir 内(防路径穿越),否则拒绝删除。
 */
export function removeConversationSessionFiles(
  options: RemoveConversationSessionFilesOptions
): void {
  const root = path.resolve(options.sessionDir);
  if (options.sessionFile) {
    const resolved = path.resolve(options.sessionFile);
    if (resolved.startsWith(`${root}${path.sep}`)) {
      try {
        rmSync(resolved, { force: true });
      } catch {}
    }
  }
  const sanitized = `${options.conversationId}::cw-`.replace(/[^A-Za-z0-9._-]/g, '_');
  const prefix = `enso-${sanitized}`;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      rmSync(path.join(root, entry), { force: true });
    } catch {}
  }
  // 超长工具输出落盘目录：tool-output/<sessionId>，子会话为 <id>-child / <id>::cw-*
  const toolRoot = path.join(root, 'tool-output');
  let toolEntries: string[] = [];
  try {
    toolEntries = readdirSync(toolRoot);
  } catch {}
  const id = options.conversationId;
  for (const entry of toolEntries) {
    if (entry !== id && !entry.startsWith(`${id}-`) && !entry.startsWith(`${id}::`)) continue;
    try {
      rmSync(path.join(toolRoot, entry), { recursive: true, force: true });
    } catch {}
  }
  removePastedTextFiles(root, id);
  removeChildRuns(root, id);
  // 未投递的完成通知：pending-notifications/<encodeURIComponent(sessionId)>.json
  const pendingRoot = path.join(root, 'pending-notifications');
  let pendingEntries: string[] = [];
  try {
    pendingEntries = readdirSync(pendingRoot);
  } catch {}
  for (const entry of pendingEntries) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(entry.replace(/\.json$/, ''));
    } catch {
      continue;
    }
    if (sessionId !== id && !sessionId.startsWith(`${id}::`) && !sessionId.startsWith(`${id}-`))
      continue;
    try {
      rmSync(path.join(pendingRoot, entry), { force: true });
    } catch {}
  }
  if (!options.scratchRoot) return;
  const scratchDir = conversationCwd({
    kind: 'scratch',
    canonicalPath: options.scratchRoot,
    conversationId: options.conversationId,
  });
  if (!scratchDir) return;
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {}
}
