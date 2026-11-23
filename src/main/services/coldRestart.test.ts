import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RESTART_CHECKPOINT_FILE, type RestartCheckpoint } from '@shared/gracefulRestart';
import type { AgentControlContext } from '@shared/types/agent';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRunLedgerEntry } from './agentRunLedger';
import { AgentService, type AgentServiceRuntime } from './agentService';
import {
  COLD_RESUME_OVERLAY_TIMEOUT_MS,
  coldResumeReady,
  failColdResume,
  loadColdRestartPlan,
  onColdResumeFailed,
  resumeColdRestartSessions,
  settleColdResume,
  trackColdResume,
  wakeColdRestartOwners,
  wakeColdRestartSession,
} from './coldRestart';
import {
  buildRestartManifest,
  type RestartManifestEntry,
  writeRestartManifest,
} from './restartManifest';

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

describe('冷启动叫醒子代理 Run 被重启打断的父会话', () => {
  const ownerContext = (ownerId: string): AgentControlContext => ({
    owner: { ownerId, projectId: 'p1', kind: 'chatSession' },
    actor: {
      kind: 'agent',
      actorId: ownerId,
      ownerId,
      projectId: 'p1',
      identity: { sessionId: ownerId, generation: `${ownerId}-gen` },
    },
  });
  const run = (ownerId: string, runId: string, notified = false): AgentRunLedgerEntry => ({
    runId,
    agentId: `agent-${runId}`,
    ownerId,
    projectId: 'p1',
    ownerKind: 'chatSession',
    mode: 'task',
    status: 'interrupted',
    createdAt: 1,
    finishedAt: 2,
    notified,
  });

  /** 冷启动：按上次的台账建 AgentService、按清单叫醒；叫醒即 spawn，就绪后 Main 调 recoverOwner */
  async function coldStart(
    ledger: AgentRunLedgerEntry[],
    sessions: Array<[string, 'model-request' | 'await-user']>,
    gone: string[] = []
  ) {
    const plan = loadColdRestartPlan(seed(500))!;
    plan.manifest.sessions = sessions.map(([sessionId, nextStep]) => ({
      ...plan.manifest.sessions[0],
      sessionId,
      nextStep,
    }));
    plan.resume = plan.manifest.sessions.filter((item) => item.nextStep === 'model-request');
    const notify = vi.fn();
    const service = new AgentService({
      runtime: {} as AgentServiceRuntime,
      ledger: { load: () => ledger, save: () => {} },
      notify,
    });
    const resume = vi.fn(async (item: RestartManifestEntry) => {
      if (gone.includes(item.sessionId)) return { ok: false, error: 'conversation unavailable' };
      service.recoverOwner(ownerContext(item.sessionId));
      return { ok: true };
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await wakeColdRestartOwners(service.restartInterruptedOwners(), resume, plan, (ownerId) =>
      service.abandonOwner(ownerId)
    );
    log.mockRestore();
    return { resume, notify, service, woken: resume.mock.calls.map(([item]) => item.sessionId) };
  }

  it('现场：父会话在清单里是 await-user，被叫醒恰好一次并收到中断通知（提示 worktree 改动还在）', async () => {
    const { woken, notify } = await coldStart(
      [run('w1-parent', 'w1-run')],
      [['w1-parent', 'await-user']]
    );
    expect(woken).toEqual(['w1-parent']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].owner.ownerId).toBe('w1-parent');
    expect(notify.mock.calls[0][1]).toContain('runId w1-run');
    expect(notify.mock.calls[0][1]).toContain('uncommitted changes');
  });

  it('没有未通知的被打断 Run：空闲会话不叫醒', async () => {
    const { woken, notify } = await coldStart(
      [run('w2-parent', 'w2-run', true)],
      [
        ['w2-parent', 'await-user'],
        ['w2-other', 'await-user'],
      ]
    );
    expect(woken).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('父会话已在冷启动续跑名单里：不重复叫醒', async () => {
    const { woken } = await coldStart(
      [run('w3-parent', 'w3-run')],
      [['w3-parent', 'model-request']]
    );
    expect(woken).toEqual([]);
  });

  it('一个父会话有多个被打断的 Run：只叫醒一次，通知一次列全', async () => {
    const { woken, notify } = await coldStart(
      [run('w4-parent', 'w4-a'), run('w4-parent', 'w4-b'), run('w4-second', 'w4-c')],
      [
        ['w4-parent', 'await-user'],
        ['w4-second', 'await-user'],
      ]
    );
    expect(woken).toEqual(['w4-parent', 'w4-second']);
    const parent = notify.mock.calls.filter(([context]) => context.owner.ownerId === 'w4-parent');
    expect(parent).toHaveLength(1);
    expect(parent[0][1]).toContain('runId w4-a');
    expect(parent[0][1]).toContain('runId w4-b');
  });

  it('父会话已删除 / 归档或不在清单里：不报错，其他父会话照常叫醒', async () => {
    const { woken, notify, service } = await coldStart(
      [run('w5-gone', 'w5-a'), run('w5-unlisted', 'w5-b'), run('w5-parent', 'w5-c')],
      [
        ['w5-gone', 'await-user'],
        ['w5-parent', 'await-user'],
      ],
      ['w5-gone']
    );
    expect(woken).toEqual(['w5-gone', 'w5-parent']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain('runId w5-c');
    // 已删除的父会话：它名下的 Run 直接结束，不再等它；不在清单里的照旧等打开时补通知
    expect(service.restartInterruptedOwners()).toEqual(['w5-unlisted']);
  });

  it('断点里的子会话随计划读出，供续跑子代理时核对', () => {
    const dir = seed(500);
    const checkpoint = JSON.parse(readFileSync(path.join(dir, RESTART_CHECKPOINT_FILE), 'utf8'));
    checkpoint.sessions.push({ ...entry('run::cw-a', 'model-request') });
    writeFileSync(path.join(dir, RESTART_CHECKPOINT_FILE), JSON.stringify(checkpoint));
    const plan = loadColdRestartPlan(dir);
    expect(plan?.children).toEqual([
      { sessionId: 'run::cw-a', generation: 'run::cw-a-gen', nextStep: 'model-request' },
    ]);
    expect(plan?.manifest.sessions.map((s) => s.sessionId)).toEqual(['run', 'idle']);
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
