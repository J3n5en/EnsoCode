import { describe, expect, it } from 'vitest';
import { migrateSessions, SESSIONS_VERSION } from './migrate';

describe('migrateSessions', () => {
  it('v0 → v1: clears stale persisted started and lands terminal state for no-sessionFile sessions', () => {
    // 旧版本把 started:true 落进了 settings.json（运行态误持久化）。
    // migrate 只跑一次且回写磁盘，旧值就此消失——不靠 onRehydrateStorage 读侧补丁。
    const persisted = {
      conversations: {
        replayable: {
          id: 'replayable',
          started: true,
          status: 'running',
          sessionFile: '/tmp/replayable.jsonl',
        },
        orphan: { id: 'orphan', started: true, status: 'running' },
        clean: { id: 'clean', started: false, status: 'idle', sessionFile: '/tmp/clean.jsonl' },
      },
      order: ['replayable', 'orphan', 'clean'],
      activeId: 'clean',
    };
    const migrated = migrateSessions(persisted, 0) as typeof persisted & {
      conversations: Record<
        string,
        { started: boolean; status: string; error?: string; sessionFile?: string }
      >;
    };
    expect(migrated.conversations.replayable).toMatchObject({ started: false, status: 'idle' });
    expect(migrated.conversations.orphan).toMatchObject({
      started: false,
      status: 'failed',
      error: 'Session ended — history not restored',
    });
    expect(migrated.conversations.clean).toMatchObject({ started: false, status: 'idle' });
    expect(migrated.order).toEqual(persisted.order);
    expect(migrated.activeId).toBe('clean');
  });

  it('returns persisted data untouched when already at the current version', () => {
    const persisted = { conversations: {}, order: [], activeId: null };
    expect(migrateSessions(persisted, SESSIONS_VERSION)).toBe(persisted);
  });

  it('tolerates malformed persisted data without throwing', () => {
    expect(migrateSessions(null, 0)).toBe(null);
    expect(migrateSessions('junk', 0)).toBe('junk');
    expect(migrateSessions({ conversations: 'junk' }, 0)).toEqual({ conversations: 'junk' });
  });
});
