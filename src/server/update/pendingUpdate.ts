import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 更新后的健康检查与回滚标记。
 * 安装新版本前写入 {from,to}；新进程启动时 resolveUpdateBoot 计数，连续崩溃（没等到
 * markUpdateReady 就重启）达到上限后要求回滚到 from；跑满健康时长后 markUpdateReady 清除。
 * 文件在数据目录：服务进程与守护/launcher 都能读写，崩溃循环里计数不会丢。
 */
export interface PendingUpdate {
  from: string;
  to: string;
  at: number;
  boots?: number;
}

/** 连续没通过健康检查就回滚的启动次数上限 */
export const ROLLBACK_BOOT_LIMIT = 3;
/** 起来多久算健康（超过即清标记） */
export const HEALTHY_AFTER_MS = 60_000;

const file = (dir: string) => path.join(dir, 'pending-update.json');

export function readPendingUpdate(dir: string): PendingUpdate | null {
  try {
    const raw = JSON.parse(readFileSync(file(dir), 'utf8')) as Record<string, unknown>;
    if (typeof raw.from !== 'string' || typeof raw.to !== 'string') return null;
    return {
      from: raw.from,
      to: raw.to,
      at: typeof raw.at === 'number' ? raw.at : 0,
      boots: typeof raw.boots === 'number' ? raw.boots : 0,
    };
  } catch {
    return null;
  }
}

export function writePendingUpdate(dir: string, update: PendingUpdate): void {
  writeFileSync(file(dir), JSON.stringify(update), { mode: 0o600 });
}

export function clearPendingUpdate(dir: string): void {
  try {
    rmSync(file(dir), { force: true });
  } catch {
    /* 清理失败不影响主流程 */
  }
}

export type UpdateBootDecision =
  | { kind: 'none' }
  | { kind: 'stale' }
  | { kind: 'booting'; from: string; to: string; boots: number }
  | { kind: 'rollback'; from: string; to: string };

/**
 * 启动时决策。版本与标记一致说明是新版本在跑：计一次启动；
 * 计数到上限说明连续崩溃（健康进程会提前 markUpdateReady 清零），要求回滚。
 * 版本对不上是手动换过版本或半安装的遗留：按过期清理，不做判断。
 */
export function resolveUpdateBoot(dir: string, version: string): UpdateBootDecision {
  const pending = readPendingUpdate(dir);
  if (!pending) return { kind: 'none' };
  if (pending.to !== version) {
    clearPendingUpdate(dir);
    return { kind: 'stale' };
  }
  const boots = (pending.boots ?? 0) + 1;
  if (boots >= ROLLBACK_BOOT_LIMIT) {
    clearPendingUpdate(dir);
    return { kind: 'rollback', from: pending.from, to: pending.to };
  }
  writePendingUpdate(dir, { ...pending, boots });
  return { kind: 'booting', from: pending.from, to: pending.to, boots };
}

/** 跑满健康时长后确认；只在标记仍是本次更新时清除（可能已被下一次更新替换） */
export function markUpdateReady(dir: string, version: string): void {
  const pending = readPendingUpdate(dir);
  if (pending && pending.to === version) clearPendingUpdate(dir);
}
