import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseRestartCheckpoint, RESTART_CHECKPOINT_FILE } from '@shared/gracefulRestart';
import {
  type RestartManifest,
  type RestartManifestEntry,
  takeRestartManifest,
} from './restartManifest';

export interface ColdRestartPlan {
  /** 交给第一代 worker 的断点文件（RESTART_CHECKPOINT_ENV） */
  checkpointFile: string;
  manifest: RestartManifest;
  /** 停在模型请求前、冷启动要主动续跑的会话 */
  resume: RestartManifestEntry[];
}

/** 清单与配套断点都在才接管；任一缺失或对不上就都不用，会话照常按需恢复 */
export function loadColdRestartPlan(dataDir: string, now = Date.now()): ColdRestartPlan | null {
  const manifest = takeRestartManifest(dataDir, now);
  if (!manifest) return null;
  const checkpointFile = path.join(dataDir, RESTART_CHECKPOINT_FILE);
  let checkpoint: ReturnType<typeof parseRestartCheckpoint> = null;
  try {
    checkpoint = parseRestartCheckpoint(JSON.parse(readFileSync(checkpointFile, 'utf8')));
  } catch {}
  if (checkpoint?.writtenAt !== manifest.checkpointWrittenAt) {
    console.warn('[graceful-restart] 恢复清单没有配套的断点，冷启动不续跑');
    return null;
  }
  return {
    checkpointFile,
    manifest,
    resume: manifest.sessions.filter((entry) => entry.nextStep === 'model-request'),
  };
}

let plan: ColdRestartPlan | null | undefined;

/** 启动时读一次（读到即归档），之后只取缓存 */
export function coldRestartPlan(dataDir: string): ColdRestartPlan | null {
  if (plan === undefined) {
    try {
      plan = loadColdRestartPlan(dataDir);
    } catch (error) {
      console.error('[graceful-restart] 读取恢复清单失败:', error);
      plan = null;
    }
  }
  return plan;
}

/** 冷启动会主动续跑的会话：退出 / 更新的中断记录要跳过它们，避免再重试一遍 */
export function coldResumedSessionIds(): ReadonlySet<string> {
  return new Set(plan?.resume.map((entry) => entry.sessionId) ?? []);
}

/** 逐个重走 spawn；单个失败只记日志，不影响其他会话 */
export async function resumeColdRestartSessions(
  current: ColdRestartPlan,
  resume: (entry: RestartManifestEntry) => Promise<{ ok: boolean; error?: string }>
): Promise<void> {
  for (const entry of current.resume) {
    const result = await resume(entry).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    console.log(
      `[graceful-restart] cold resume ${entry.sessionId.slice(0, 8)} ${result.ok ? 'ok' : `failed: ${result.error}`}`
    );
  }
}
