import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseRestartCheckpoint,
  RESTART_CHECKPOINT_FILE,
  type RestartCheckpointEntry,
} from '@shared/gracefulRestart';
import {
  type RestartManifest,
  type RestartManifestEntry,
  takeRestartManifest,
} from './restartManifest';

/** 断点里停在安全点的子会话：子代理 Run 据此在重启后接着跑 */
export type ColdRestartChild = Pick<
  RestartCheckpointEntry,
  'sessionId' | 'generation' | 'nextStep'
>;

/** 清单里的会话已删除 / 归档：冷启动重开它时的错误 */
export const CONVERSATION_UNAVAILABLE = 'conversation unavailable';

export interface ColdRestartPlan {
  /** 交给第一代 worker 的断点文件（RESTART_CHECKPOINT_ENV） */
  checkpointFile: string;
  manifest: RestartManifest;
  /** 停在模型请求前、冷启动要主动续跑的会话 */
  resume: RestartManifestEntry[];
  children: ColdRestartChild[];
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
    children: checkpoint.sessions
      .filter((entry) => entry.sessionId.includes('::') && entry.toolsInFlight.length === 0)
      .map(({ sessionId, generation, nextStep }) => ({ sessionId, generation, nextStep })),
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

/** 冷启动断点里停在安全点的子会话（没有接管的清单时为空） */
export function coldRestartChildren(): readonly ColdRestartChild[] {
  return plan?.children ?? [];
}

const woken = new Set<string>();

/**
 * worker 请求叫醒（认回的后台命令在空闲会话里结束）：按清单重走 spawn，不续跑；
 * 清单里没有的、冷启动本就在续跑的、已叫过的都不重复打开
 */
export async function wakeColdRestartSession(
  sessionId: string,
  resume: (entry: RestartManifestEntry) => Promise<{ ok: boolean; error?: string }>,
  current: ColdRestartPlan | null = plan ?? null
): Promise<{ ok: boolean; error?: string }> {
  const entry = current?.manifest.sessions.find((item) => item.sessionId === sessionId);
  if (!entry) return { ok: false, error: 'not in restart manifest' };
  if (entry.nextStep === 'model-request') return { ok: false, error: 'resumed by cold restart' };
  if (woken.has(sessionId)) return { ok: false, error: 'already woken' };
  woken.add(sessionId);
  return resume(entry).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
}

/**
 * 子代理 Run 被重启打断、父会话还不知情：父会话只在就绪时由 recoverOwner 补通知，
 * 冷启动不续跑的父会话（等用户）要叫醒一次，否则要等有人打开它才知道
 */
export async function wakeColdRestartOwners(
  ownerIds: Iterable<string>,
  resume: (entry: RestartManifestEntry) => Promise<{ ok: boolean; error?: string }>,
  current: ColdRestartPlan | null = plan ?? null,
  /** 父会话已删除 / 归档：它名下的 Run 不再等它 */
  onUnavailable?: (sessionId: string) => void
): Promise<void> {
  for (const sessionId of new Set(ownerIds)) {
    const result = await wakeColdRestartSession(sessionId, resume, current);
    console.log(
      `[graceful-restart] wake owner of interrupted subagent runs ${sessionId.slice(0, 8)} ${result.ok ? 'ok' : `skipped: ${result.error}`}`
    );
    if (result.error === CONVERSATION_UNAVAILABLE) onUnavailable?.(sessionId);
  }
}

/** 「正在恢复会话」最多挡这么久：恢复卡住也要让用户能用 */
export const COLD_RESUME_OVERLAY_TIMEOUT_MS = 30_000;

let resumePending: Set<string> | null = null;
let endResume: (() => void) | undefined;

/**
 * 有会话要续跑就开「正在恢复会话」：清单里要续跑的会话全部结算（worker 报 parent-ready、spawn 被拒，
 * 或派发失败）即关；到上限还没结算完也关并记日志。没有要续跑的会话不开，免得每次启动都闪一下
 */
export function trackColdResume(
  current: ColdRestartPlan | null,
  setResuming: (resuming: boolean) => void,
  timeoutMs = COLD_RESUME_OVERLAY_TIMEOUT_MS
): void {
  endResume?.();
  const pending = new Set(current?.resume.map((entry) => entry.sessionId));
  if (pending.size === 0) return;
  const end = () => {
    if (resumePending !== pending) return;
    resumePending = null;
    endResume = undefined;
    clearTimeout(timer);
    setResuming(false);
  };
  const timer = setTimeout(() => {
    console.warn(
      `[graceful-restart] 恢复会话 ${timeoutMs / 1000}s 未完成，关掉恢复提示；未就绪：${[...pending].map((id) => id.slice(0, 8)).join(', ')}`
    );
    end();
  }, timeoutMs);
  resumePending = pending;
  endResume = end;
  setResuming(true);
}

/** 一个续跑会话有了结果（就绪 / 失败）；清单外的、已结算的忽略 */
export function settleColdResume(sessionId: string): void {
  if (!resumePending?.delete(sessionId)) return;
  if (resumePending.size === 0) endResume?.();
}

/** 还没就绪也没失败的续跑会话；续跑失败的会话与原因 */
const resumeOutstanding = new Set<string>();
const resumeFailures = new Map<string, string>();
const resumeFailureListeners = new Set<(sessionId: string, error: string) => void>();

/** 续跑会话就绪（worker 报 parent-ready） */
export function coldResumeReady(sessionId: string): void {
  resumeOutstanding.delete(sessionId);
  settleColdResume(sessionId);
}

/** 续跑会话没接上（派发失败或 spawn 被拒）：每个会话报一次；已就绪的、清单外的不算 */
export function failColdResume(sessionId: string, error: string): void {
  settleColdResume(sessionId);
  if (!resumeOutstanding.delete(sessionId)) return;
  resumeFailures.set(sessionId, error);
  for (const listener of resumeFailureListeners) listener(sessionId, error);
}

/** 订阅续跑失败：已经失败的立即补报（秘书宿主晚于续跑启动）；返回退订 */
export function onColdResumeFailed(
  listener: (sessionId: string, error: string) => void
): () => void {
  resumeFailureListeners.add(listener);
  for (const [sessionId, error] of resumeFailures) listener(sessionId, error);
  return () => resumeFailureListeners.delete(listener);
}

/** 逐个重走 spawn；单个失败只记日志并报续跑失败，不影响其他会话；派发失败的直接算结算，不等 worker */
export async function resumeColdRestartSessions(
  current: ColdRestartPlan,
  resume: (entry: RestartManifestEntry) => Promise<{ ok: boolean; error?: string }>
): Promise<void> {
  resumeOutstanding.clear();
  resumeFailures.clear();
  for (const entry of current.resume) resumeOutstanding.add(entry.sessionId);
  for (const entry of current.resume) {
    const result = await resume(entry).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    console.log(
      `[graceful-restart] cold resume ${entry.sessionId.slice(0, 8)} ${result.ok ? 'ok' : `failed: ${result.error}`}`
    );
    if (!result.ok) failColdResume(entry.sessionId, result.error ?? 'resume failed');
  }
}
