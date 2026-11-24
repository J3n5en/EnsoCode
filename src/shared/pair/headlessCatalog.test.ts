import { describe, expect, it } from 'vitest';
import {
  catalogEntryFromPairSession,
  catalogParked,
  catalogQueued,
  catalogQueueOverride,
  patchCatalogEntry,
  upsertCatalogEntry,
} from './headlessCatalog';

const base = {
  id: 's1',
  title: 'One',
  projectName: 'proj',
  projectId: 'p1',
  status: 'idle',
};

describe('headless catalog', () => {
  it('patches a known entry and prepends unknown ones', () => {
    expect(patchCatalogEntry([base], 's1', { status: 'running' })[0]?.status).toBe('running');
    const created = upsertCatalogEntry([base], { ...base, id: 's2', title: 'Two' });
    expect(created.map((entry) => entry.id)).toEqual(['s2', 's1']);
  });

  it('builds a phone catalog row from a pair spawn', () => {
    const entry = catalogEntryFromPairSession(
      {
        sessionId: 's9',
        projectId: 'p1',
        providerId: 'prov',
        modelId: 'm',
        reasoningEnabled: false,
      },
      'proj'
    );
    expect(entry).toMatchObject({
      id: 's9',
      projectId: 'p1',
      status: 'idle',
      providerId: 'prov',
      modelId: 'm',
    });
  });

  it('marks queued images without sending bytes', () => {
    expect(
      catalogQueued([{ id: 'q1', text: 'hi', images: [{ data: 'x', mimeType: 'image/png' }] }])
    ).toEqual([{ id: 'q1', text: 'hi', hasImages: true }]);
  });

  it('queuedStart 行是 queued，失败不占位次', () => {
    expect(
      catalogQueueOverride(
        {
          id: 'a',
          secretaryOrigin: { secretaryConversationId: 'sec' },
          queuedStart: { queuedAt: 2, text: 'go' },
        },
        1
      )
    ).toEqual({ status: 'queued', queuePosition: 1 });
    expect(
      catalogQueueOverride(
        {
          id: 'b',
          secretaryOrigin: { secretaryConversationId: 'sec' },
          queuedStart: { queuedAt: 1, text: 'go', failed: { at: 3, error: 'full' } },
        },
        undefined
      )
    ).toEqual({ status: 'queued', queueFailed: 'full' });
    expect(catalogQueueOverride({ id: 'c' }, 1)).toBeUndefined();
  });

  it('空闲等待原因：等上游恢复优先，其次未到点提醒；运行中或提醒已过宽限期不标', () => {
    const retry = {
      reason: 'upstream' as const,
      kind: 'transient' as const,
      provider: 'x',
      attempt: 1,
      since: 1,
      at: 2,
      lastError: 'e',
    };
    const now = 1_000_000;
    const soon = [{ dueAt: now + 60_000 }];
    expect(catalogParked({ status: 'idle', goal: { status: 'waiting', retry } }, soon, now)).toBe(
      'upstream'
    );
    expect(catalogParked({ status: 'idle' }, soon, now)).toBe('reminder');
    expect(catalogParked({ status: 'running' }, soon, now)).toBeUndefined();
    expect(catalogParked({ status: 'idle' }, [{ dueAt: now - 10 * 60_000 }], now)).toBeUndefined();
    expect(catalogParked({ status: 'idle' }, undefined, now)).toBeUndefined();
  });
});
