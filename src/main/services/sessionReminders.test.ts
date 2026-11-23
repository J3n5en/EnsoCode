import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSessionReminders } from './sessionReminders';

describe('readSessionReminders', () => {
  it('读 sessions/reminders.json：根会话自己和子会话的提醒；文件缺失或损坏返回空', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-session-reminders-'));
    expect(readSessionReminders('root', dir)).toEqual([]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'reminders.json'), '{broken');
    expect(readSessionReminders('root', dir)).toEqual([]);
    const base = { createdAt: 0, prompt: 'p', ifIdle: true, chain: 1 };
    writeFileSync(
      path.join(dir, 'reminders.json'),
      JSON.stringify({
        version: 1,
        reminders: [
          { ...base, id: 'r00000001', sessionId: 'root', dueAt: 20 },
          { ...base, id: 'r00000002', sessionId: 'root::cw-a', dueAt: 10, label: 'ci' },
          { ...base, id: 'r00000003', sessionId: 'other', dueAt: 5 },
        ],
        chains: {},
      })
    );
    expect(readSessionReminders('root', dir).map((item) => item.id)).toEqual([
      'r00000002',
      'r00000001',
    ]);
  });
});
