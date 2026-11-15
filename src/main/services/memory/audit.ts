import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryDeletionImpact } from '@shared/memory/dto';
import { contentHash } from './contentHash';
import type { ForgettingRunSummary } from './forgetting';
import type { ManualEditResult } from './manual';

const MAX_BYTES = 5 * 1024 * 1024;

/** 人工编辑 / 删除审计。正文只记 hash 与长度：用户改正文常是为了抹掉不该留的内容，审计不能把它再存一份 */
export type MemoryAuditEntry =
  | {
      ts: string;
      action: 'memory.edit';
      actor: 'user';
      memoryId: string;
      spaceId: string;
      changes: {
        title?: { from: string; to: string };
        unitType?: { from: string; to: string };
        importance?: { from: number; to: number };
        content?: { fromHash: string; toHash: string; fromChars: number; toChars: number };
      };
    }
  | {
      ts: string;
      action: 'memory.delete';
      actor: 'user';
      requested: string[];
      impact: MemoryDeletionImpact;
    }
  /** 遗忘巡检每跑一次记一条：处理了多少条、多少进候选、自动归档了多少 */
  | {
      ts: string;
      action: 'memory.decay';
      actor: 'system';
      summary: ForgettingRunSummary;
    }
  /** 归档（只改 lifecycle_state，可还原）；删除不在这里记，走 memory.delete */
  | {
      ts: string;
      action: 'memory.archive';
      actor: 'user' | 'system';
      ids: string[];
      reason: 'candidates' | 'auto';
    };

export function editAuditEntry(result: ManualEditResult, now = new Date()): MemoryAuditEntry {
  const { before, memory } = result;
  const changes: Extract<MemoryAuditEntry, { action: 'memory.edit' }>['changes'] = {};
  if (before.title !== memory.title) changes.title = { from: before.title, to: memory.title };
  if (before.unitType !== memory.unitType) {
    changes.unitType = { from: before.unitType, to: memory.unitType };
  }
  if (before.importance !== memory.importance) {
    changes.importance = { from: before.importance, to: memory.importance };
  }
  if (before.content !== memory.content) {
    changes.content = {
      fromHash: contentHash(before.content),
      toHash: contentHash(memory.content),
      fromChars: Array.from(before.content).length,
      toChars: Array.from(memory.content).length,
    };
  }
  return {
    ts: now.toISOString(),
    action: 'memory.edit',
    actor: 'user',
    memoryId: memory.id,
    spaceId: memory.spaceId,
    changes,
  };
}

/** <dir>/audit.jsonl：只追加，超过 5MB 轮转一份；写失败不影响已完成的变更 */
export function appendMemoryAudit(dir: string, entry: MemoryAuditEntry): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'audit.jsonl');
    try {
      if (statSync(file).size >= MAX_BYTES) renameSync(file, join(dir, 'audit.1.jsonl'));
    } catch {}
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {}
}
