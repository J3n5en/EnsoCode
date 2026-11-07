import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INTERRUPTED_SESSIONS_FILE,
  recordInterruptedSessions,
  takeInterruptedSessions,
} from './interruptedSessions';

describe('interruptedSessions', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'enso-interrupted-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('记录后取一次即删除，第二次为空', () => {
    recordInterruptedSessions(dir, ['a', 'b', 'a'], 1000);
    expect(takeInterruptedSessions(dir, 2000)).toEqual(['a', 'b']);
    expect(takeInterruptedSessions(dir, 2000)).toEqual([]);
  });

  it('空列表不留文件，旧记录被清掉', () => {
    recordInterruptedSessions(dir, ['a'], 1000);
    recordInterruptedSessions(dir, [], 1000);
    expect(() => readFileSync(path.join(dir, INTERRUPTED_SESSIONS_FILE))).toThrow();
  });

  it('超过一天的记录、坏文件和脏值都不返回', () => {
    recordInterruptedSessions(dir, ['a'], 0);
    expect(takeInterruptedSessions(dir, 25 * 60 * 60 * 1000)).toEqual([]);
    const file = path.join(dir, INTERRUPTED_SESSIONS_FILE);
    writeFileSync(file, '{oops');
    expect(takeInterruptedSessions(dir, 0)).toEqual([]);
    writeFileSync(file, JSON.stringify({ v: 1, at: 0, sessionIds: ['ok', '', 3, null] }));
    expect(takeInterruptedSessions(dir, 0)).toEqual(['ok']);
  });
});
