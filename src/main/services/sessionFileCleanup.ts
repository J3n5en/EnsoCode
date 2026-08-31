import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

export interface RemoveConversationSessionFilesOptions {
  sessionDir: string;
  conversationId: string;
  sessionFile?: string;
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
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      rmSync(path.join(root, entry), { force: true });
    } catch {}
  }
}
