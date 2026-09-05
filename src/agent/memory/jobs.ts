import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type Stage1JobStatus = 'idle' | 'running' | 'done' | 'failed';

export type Stage1Job = {
  status: Stage1JobStatus;
  sourceUpdatedAt: number;
  lastSuccessWatermark?: number;
  leaseUntil?: number;
  retryAt?: number;
  ownershipToken?: string;
};

export type MemoryJobsState = {
  stage1: Record<string, Stage1Job>;
  global: {
    watermark: number;
    leaseUntil?: number;
    ownershipToken?: string;
    status?: Stage1JobStatus;
    /** `/memory enqueue`：下次启动即使没有新 Phase 1 也跑合并 */
    dirty?: boolean;
  };
};

const JOBS_FILE = '.jobs.json';

const emptyState = (): MemoryJobsState => ({ stage1: {}, global: { watermark: 0 } });

export async function loadJobs(memoryRoot: string): Promise<MemoryJobsState> {
  try {
    const raw = await readFile(path.join(memoryRoot, JOBS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as MemoryJobsState;
    if (!parsed || typeof parsed !== 'object' || !parsed.stage1 || !parsed.global) {
      return emptyState();
    }
    return parsed;
  } catch {
    return emptyState();
  }
}

export async function saveJobs(memoryRoot: string, state: MemoryJobsState): Promise<void> {
  await mkdir(memoryRoot, { recursive: true });
  await writeFile(path.join(memoryRoot, JOBS_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function claimStage1(
  state: MemoryJobsState,
  thread: { threadId: string; updatedAtSec: number },
  opts: { nowSec: number; leaseSeconds: number; workerToken: string }
): { claimed: boolean; state: MemoryJobsState; token?: string } {
  const existing = state.stage1[thread.threadId];
  if ((existing?.lastSuccessWatermark ?? 0) >= thread.updatedAtSec) {
    return { claimed: false, state };
  }
  if (
    existing?.status === 'running' &&
    existing.leaseUntil !== undefined &&
    existing.leaseUntil > opts.nowSec
  ) {
    return { claimed: false, state };
  }
  const next: MemoryJobsState = {
    ...state,
    stage1: {
      ...state.stage1,
      [thread.threadId]: {
        status: 'running',
        sourceUpdatedAt: thread.updatedAtSec,
        lastSuccessWatermark: existing?.lastSuccessWatermark,
        leaseUntil: opts.nowSec + opts.leaseSeconds,
        ownershipToken: opts.workerToken,
      },
    },
  };
  return { claimed: true, state: next, token: opts.workerToken };
}

export function markStage1Done(
  state: MemoryJobsState,
  threadId: string,
  opts: { token: string; watermark: number }
): MemoryJobsState | undefined {
  const existing = state.stage1[threadId];
  if (!existing || existing.ownershipToken !== opts.token) return undefined;
  return {
    ...state,
    stage1: {
      ...state.stage1,
      [threadId]: {
        status: 'done',
        sourceUpdatedAt: existing.sourceUpdatedAt,
        lastSuccessWatermark: opts.watermark,
      },
    },
  };
}

export function enqueuePhase2(state: MemoryJobsState): MemoryJobsState {
  return {
    ...state,
    global: {
      watermark: state.global.watermark,
      dirty: true,
      status: 'idle',
    },
  };
}

export function tryClaimPhase2(
  state: MemoryJobsState,
  opts: { nowSec: number; leaseSeconds: number; workerToken: string; newWatermark: number }
): { claimed: boolean; state: MemoryJobsState; token?: string } {
  const global = state.global;
  if (global.watermark >= opts.newWatermark && !global.dirty) return { claimed: false, state };
  if (
    global.status === 'running' &&
    global.leaseUntil !== undefined &&
    global.leaseUntil > opts.nowSec
  ) {
    return { claimed: false, state };
  }
  return {
    claimed: true,
    token: opts.workerToken,
    state: {
      ...state,
      global: {
        watermark: global.watermark,
        leaseUntil: opts.nowSec + opts.leaseSeconds,
        ownershipToken: opts.workerToken,
        status: 'running',
      },
    },
  };
}
