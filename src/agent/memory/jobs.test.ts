import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claimStage1,
  enqueuePhase2,
  loadJobs,
  type MemoryJobsState,
  markStage1Done,
  saveJobs,
  tryClaimPhase2,
} from './jobs';

function memoryRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'enso-jobs-'));
}

const emptyState: MemoryJobsState = { stage1: {}, global: { watermark: 0 } };

describe('memory jobs sidecar', () => {
  it('loadJobs returns default state when file is missing', async () => {
    const state = await loadJobs(memoryRoot());
    expect(state).toEqual(emptyState);
  });

  it('claimStage1 skips already-consolidated threads and claims fresh ones', () => {
    const consolidated: MemoryJobsState = {
      stage1: { t1: { status: 'done', sourceUpdatedAt: 100, lastSuccessWatermark: 100 } },
      global: { watermark: 0 },
    };
    const skip = claimStage1(
      consolidated,
      { threadId: 't1', updatedAtSec: 100 },
      { nowSec: 200, leaseSeconds: 60, workerToken: 'w1' }
    );
    expect(skip.claimed).toBe(false);

    const claim = claimStage1(
      emptyState,
      { threadId: 't2', updatedAtSec: 150 },
      { nowSec: 200, leaseSeconds: 60, workerToken: 'w1' }
    );
    expect(claim.claimed).toBe(true);
    expect(claim.state.stage1.t2).toMatchObject({ status: 'running', leaseUntil: 260 });
    expect(claim.token).toBeTruthy();
  });

  it('claimStage1 skips a thread with a still-valid running lease, but reclaims an expired one', () => {
    const running: MemoryJobsState = {
      stage1: { t1: { status: 'running', sourceUpdatedAt: 100, leaseUntil: 300 } },
      global: { watermark: 0 },
    };
    const skip = claimStage1(
      running,
      { threadId: 't1', updatedAtSec: 100 },
      { nowSec: 200, leaseSeconds: 60, workerToken: 'w2' }
    );
    expect(skip.claimed).toBe(false);

    const expired: MemoryJobsState = {
      stage1: { t1: { status: 'running', sourceUpdatedAt: 100, leaseUntil: 150 } },
      global: { watermark: 0 },
    };
    const reclaim = claimStage1(
      expired,
      { threadId: 't1', updatedAtSec: 100 },
      { nowSec: 200, leaseSeconds: 60, workerToken: 'w2' }
    );
    expect(reclaim.claimed).toBe(true);
  });

  it('markStage1Done rejects wrong token and applies right token', () => {
    const claim = claimStage1(
      emptyState,
      { threadId: 't1', updatedAtSec: 150 },
      { nowSec: 200, leaseSeconds: 60, workerToken: 'w1' }
    );
    const wrong = markStage1Done(claim.state, 't1', { token: 'bogus', watermark: 150 });
    expect(wrong).toBeUndefined();

    const right = markStage1Done(claim.state, 't1', {
      token: claim.token as string,
      watermark: 150,
    });
    expect(right?.stage1.t1).toMatchObject({ status: 'done', lastSuccessWatermark: 150 });
  });

  it('tryClaimPhase2 skips when watermark already caught up or lease still valid, else claims', () => {
    const caughtUp: MemoryJobsState = { stage1: {}, global: { watermark: 500 } };
    const skipWatermark = tryClaimPhase2(caughtUp, {
      nowSec: 200,
      leaseSeconds: 60,
      workerToken: 'w1',
      newWatermark: 400,
    });
    expect(skipWatermark.claimed).toBe(false);

    const leased: MemoryJobsState = {
      stage1: {},
      global: { watermark: 100, leaseUntil: 300, status: 'running' },
    };
    const skipLease = tryClaimPhase2(leased, {
      nowSec: 200,
      leaseSeconds: 60,
      workerToken: 'w1',
      newWatermark: 400,
    });
    expect(skipLease.claimed).toBe(false);

    const claim = tryClaimPhase2(emptyState, {
      nowSec: 200,
      leaseSeconds: 60,
      workerToken: 'w1',
      newWatermark: 400,
    });
    expect(claim.claimed).toBe(true);
    expect(claim.state.global).toMatchObject({ leaseUntil: 260, status: 'running' });
    const dirty = enqueuePhase2({ stage1: {}, global: { watermark: 400 } });
    expect(dirty.global.dirty).toBe(true);
    expect(
      tryClaimPhase2(dirty, {
        nowSec: 200,
        leaseSeconds: 60,
        workerToken: 'w1',
        newWatermark: 400,
      }).claimed
    ).toBe(true);
  });

  it('saveJobs then loadJobs roundtrips the state', async () => {
    const root = memoryRoot();
    const state: MemoryJobsState = {
      stage1: { t1: { status: 'done', sourceUpdatedAt: 100, lastSuccessWatermark: 100 } },
      global: { watermark: 100 },
    };
    await saveJobs(root, state);
    expect(await loadJobs(root)).toEqual(state);
  });
});
