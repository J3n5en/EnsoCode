import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RESTART_CHECKPOINT_FILE, type RestartCheckpoint } from '@shared/gracefulRestart';
import { describe, expect, it, vi } from 'vitest';
import {
  COLD_RESUME_OVERLAY_TIMEOUT_MS,
  coldResumeReady,
  failColdResume,
  loadColdRestartPlan,
  onColdResumeFailed,
  resumeColdRestartSessions,
  settleColdResume,
  trackColdResume,
  wakeColdRestartSession,
} from './coldRestart';
import { buildRestartManifest, writeRestartManifest } from './restartManifest';

const entry = (sessionId: string, nextStep: 'model-request' | 'await-user') => ({
  sessionId,
  generation: `${sessionId}-gen`,
  sessionFile: `/data/sessions/${sessionId}.jsonl`,
  seq: 3,
  nextStep,
  turnId: nextStep === 'model-request' ? `${sessionId}-turn` : null,
  lastCompletedToolCallId: nextStep === 'model-request' ? 'call-1' : null,
  messageCount: 2,
  toolsInFlight: [],
});

function seed(checkpointWrittenAt: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'enso-cold-restart-'));
  const checkpoint: RestartCheckpoint = {
    version: 1,
    pid: 1,
    writtenAt: 500,
    sessions: [entry('run', 'model-request'), entry('idle', 'await-user')],
  };
  writeFileSync(path.join(dir, RESTART_CHECKPOINT_FILE), JSON.stringify(checkpoint));
  writeRestartManifest(
    dir,
    buildRestartManifest({
      reason: 'quit',
      checkpoint: { ...checkpoint, writtenAt: checkpointWrittenAt },
      settingsOf: () => ({ providerId: 'p', modelId: 'm', cwd: '/w' }),
    })
  );
  return dir;
}

describe('coldRestart', () => {
  it('清单与配套断点都在：只主动续跑停在模型请求前的会话', () => {
    const dir = seed(500);
    const plan = loadColdRestartPlan(dir);
    expect(plan?.checkpointFile).toBe(path.join(dir, RESTART_CHECKPOINT_FILE));
    expect(plan?.manifest.sessions.map((s) => s.sessionId)).toEqual(['run', 'idle']);
    expect(plan?.resume.map((s) => s.sessionId)).toEqual(['run']);
  });

  it('断点不是这份清单配套的：不接管', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadColdRestartPlan(seed(499))).toBeNull();
    warn.mockRestore();
  });

  it('单个会话恢复失败不影响其他会话', async () => {
    const dir = seed(500);
    const plan = loadColdRestartPlan(dir)!;
    plan.resume.push({ ...plan.resume[0], sessionId: 'second' });
    const seen: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await resumeColdRestartSessions(plan, async (item) => {
      seen.push(item.sessionId);
      if (item.sessionId === 'run') throw new Error('boom');
      return { ok: true };
    });
    expect(seen).toEqual(['run', 'second']);
    log.mockRestore();
  });

  it('叫醒空闲会话：按清单重走 spawn 一次；续跑中的、清单外的不打开', async () => {
    const plan = loadColdRestartPlan(seed(500))!;
    const resume = vi.fn(async () => ({ ok: true }));
    expect(await wakeColdRestartSession('idle', resume, plan)).toEqual({ ok: true });
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'idle' }));
    expect((await wakeColdRestartSession('idle', resume, plan)).ok).toBe(false);
    expect((await wakeColdRestartSession('run', resume, plan)).ok).toBe(false);
    expect((await wakeColdRestartSession('ghost', resume, plan)).ok).toBe(false);
    expect((await wakeColdRestartSession('idle', resume, null)).ok).toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

describe('冷启动续跑失败', () => {
  it('派发失败、spawn 被拒的续跑会话报给订阅者（晚订阅也补到）；已就绪的、清单外的、重复的不报', async () => {
    const plan = loadColdRestartPlan(seed(500))!;
    plan.resume.push({ ...plan.resume[0], sessionId: 'rejected' });
    plan.resume.push({ ...plan.resume[0], sessionId: 'ready' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const resuming = resumeColdRestartSessions(plan, async (item) =>
      item.sessionId === 'run' ? { ok: false, error: 'no model' } : { ok: true }
    );
    const early: Array<[string, string]> = [];
    const offEarly = onColdResumeFailed((id, error) => early.push([id, error]));
    await resuming;
    coldResumeReady('ready');
    failColdResume('ready', 'later spawn');
    failColdResume('rejected', 'spawn rejected');
    failColdResume('rejected', 'again');
    failColdResume('ghost', 'not in plan');
    expect(early).toEqual([
      ['run', 'no model'],
      ['rejected', 'spawn rejected'],
    ]);
    const late: string[] = [];
    const offLate = onColdResumeFailed((id) => late.push(id));
    expect(late).toEqual(['run', 'rejected']);
    offEarly();
    offLate();
    log.mockRestore();
  });
});

describe('冷启动恢复提示', () => {
  const planWith = (...ids: string[]) => {
    const plan = loadColdRestartPlan(seed(500))!;
    plan.resume = ids.map((id) => ({ ...plan.resume[0], sessionId: id }));
    return plan;
  };

  it('没有要续跑的会话：不开提示', () => {
    const setResuming = vi.fn();
    trackColdResume(null, setResuming);
    trackColdResume(planWith(), setResuming);
    settleColdResume('run');
    expect(setResuming).not.toHaveBeenCalled();
  });

  it('有清单：立刻开提示，要续跑的会话全部就绪才关；清单外的、重复的不算', () => {
    const setResuming = vi.fn();
    trackColdResume(planWith('a', 'b'), setResuming);
    expect(setResuming.mock.calls).toEqual([[true]]);
    settleColdResume('ghost');
    settleColdResume('a');
    settleColdResume('a');
    expect(setResuming.mock.calls).toEqual([[true]]);
    settleColdResume('b');
    expect(setResuming.mock.calls).toEqual([[true], [false]]);
    settleColdResume('b');
    expect(setResuming).toHaveBeenCalledTimes(2);
  });

  it('派发失败的会话直接算结算，不等 worker', async () => {
    const setResuming = vi.fn();
    const plan = planWith('a', 'b');
    trackColdResume(plan, setResuming);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await resumeColdRestartSessions(plan, async (item) =>
      item.sessionId === 'a' ? { ok: false, error: 'conversation unavailable' } : { ok: true }
    );
    expect(setResuming.mock.calls).toEqual([[true]]);
    settleColdResume('b');
    expect(setResuming.mock.calls).toEqual([[true], [false]]);
    log.mockRestore();
  });

  it('恢复卡住：到上限关掉提示并记日志，之后迟到的就绪不再动它', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const setResuming = vi.fn();
      trackColdResume(planWith('stuck'), setResuming);
      vi.advanceTimersByTime(COLD_RESUME_OVERLAY_TIMEOUT_MS - 1);
      expect(setResuming.mock.calls).toEqual([[true]]);
      vi.advanceTimersByTime(1);
      expect(setResuming.mock.calls).toEqual([[true], [false]]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('stuck'));
      settleColdResume('stuck');
      expect(setResuming).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('按时恢复完成：上限到点不再重复关', () => {
    vi.useFakeTimers();
    try {
      const setResuming = vi.fn();
      trackColdResume(planWith('a'), setResuming);
      settleColdResume('a');
      vi.advanceTimersByTime(COLD_RESUME_OVERLAY_TIMEOUT_MS);
      expect(setResuming.mock.calls).toEqual([[true], [false]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
