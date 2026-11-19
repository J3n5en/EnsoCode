import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RESTART_CHECKPOINT_FILE, type RestartCheckpoint } from '@shared/gracefulRestart';
import { describe, expect, it, vi } from 'vitest';
import { loadColdRestartPlan, resumeColdRestartSessions } from './coldRestart';
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
});
