import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from './db';
import {
  approvePendingWrite,
  listPendingWrites,
  queuePendingWrite,
  rejectPendingWrite,
} from './pending';
import { createMemory, listMemories } from './store';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-memory-pending-'));
  db = openMemoryDb(path.join(dir, 'memory.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const BOT = '22222222-2222-4222-8222-222222222222';
const queueCapture = (content: string) =>
  queuePendingWrite(db, {
    kind: 'capture',
    spaceId: 'global',
    title: 't',
    content,
    botId: BOT,
    chatId: null,
    redacted: false,
    payload: { importance: 0.7, unitType: 'fact', unitTypeSource: 'explicit' },
  });

describe('memory pending writes', () => {
  it('排队不落 memories，列表可见', () => {
    const pending = queueCapture('global pref');
    expect(listMemories(db, { spaceIds: ['global'] })).toHaveLength(0);
    expect(listPendingWrites(db)).toEqual([
      expect.objectContaining({ id: pending.id, kind: 'capture', spaceId: 'global', botId: BOT }),
    ]);
  });

  it('批准后写入目标空间并移出待审批', async () => {
    const pending = queueCapture('user likes tabs');
    const created: string[] = [];
    const result = await approvePendingWrite(db, pending.id, {
      onCreated: (memory) => created.push(memory.id),
    });
    expect(result.ok).toBe(true);
    const rows = listMemories(db, { spaceIds: ['global'] });
    expect(rows.map((m) => [m.content, m.importance, m.source])).toEqual([
      ['user likes tabs', 0.7, 'agent'],
    ]);
    expect(created).toEqual([rows[0].id]);
    expect(listPendingWrites(db)).toEqual([]);
  });

  it('批准结晶：源仍有效时写入结晶', async () => {
    const ids: string[] = [];
    for (const content of ['a fact', 'b fact', 'c fact']) {
      const r = await createMemory(db, { content, spaceId: 'global' });
      if (r.status === 'inserted') ids.push(r.memory.id);
    }
    const pending = queuePendingWrite(db, {
      kind: 'crystallize',
      spaceId: 'global',
      title: 'abc',
      content: 'a, b and c facts together',
      botId: BOT,
      chatId: null,
      redacted: false,
      payload: { sourceIds: ids },
    });
    const result = await approvePendingWrite(db, pending.id, {});
    expect(result).toMatchObject({ ok: true, memory: { isCrystal: true } });
    expect(listPendingWrites(db)).toEqual([]);
  });

  it('拒绝只删待审批，不写库；未知 id 报错', async () => {
    const pending = queueCapture('nope');
    expect(rejectPendingWrite(db, pending.id)).toBe(true);
    expect(rejectPendingWrite(db, pending.id)).toBe(false);
    expect(listMemories(db, { spaceIds: ['global'] })).toHaveLength(0);
    await expect(approvePendingWrite(db, pending.id, {})).resolves.toMatchObject({ ok: false });
  });
});
