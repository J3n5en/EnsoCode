import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRunningAtExit,
  readRunningAtExit,
  runningAtExitPath,
  startRunningAtExitHeartbeat,
  writeRunningAtExit,
} from './runningAtExit';

describe('runningAtExit', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'enso-running-at-exit-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('退出时写入正在跑的会话，读回同一份', () => {
    writeRunningAtExit(dir, {
      pid: 99,
      kind: 'update',
      at: 1000,
      sessions: [{ conversationId: 'c1', turnId: 't1', startedAt: 900, lastMessageIndex: 4 }],
    });
    expect(readRunningAtExit(dir)).toEqual({
      v: 1,
      at: 1000,
      pid: 99,
      kind: 'update',
      sessions: [{ conversationId: 'c1', turnId: 't1', startedAt: 900, lastMessageIndex: 4 }],
    });
  });

  it('没有正在跑的会话就不留文件，旧记录被清掉', () => {
    writeRunningAtExit(dir, {
      pid: 1,
      kind: 'quit',
      at: 1,
      sessions: [{ conversationId: 'c', startedAt: 1 }],
    });
    expect(existsSync(runningAtExitPath(dir))).toBe(true);
    writeRunningAtExit(dir, { pid: 1, kind: 'quit', at: 2, sessions: [] });
    expect(existsSync(runningAtExitPath(dir))).toBe(false);
  });

  it('坏文件读成 null，不抛给退出路径', () => {
    writeFileSync(runningAtExitPath(dir), '{oops');
    expect(readRunningAtExit(dir)).toBeNull();
    clearRunningAtExit(dir);
    expect(readRunningAtExit(dir)).toBeNull();
  });

  it('心跳只写正在跑的会话，空闲时清掉文件', () => {
    let running = [{ conversationId: 'c1', startedAt: 5 }];
    const heartbeat = startRunningAtExitHeartbeat({
      dir,
      pid: 7,
      kind: 'quit',
      snapshot: () => running,
      now: () => 500,
      intervalMs: 60_000,
    });
    heartbeat.beat();
    expect(readRunningAtExit(dir)?.sessions).toEqual([{ conversationId: 'c1', startedAt: 5 }]);
    running = [];
    heartbeat.beat();
    expect(existsSync(runningAtExitPath(dir))).toBe(false);
    heartbeat.stop();
  });

  it('写入是 tmp + rename：不留半份 JSON', () => {
    writeRunningAtExit(dir, {
      pid: 1,
      kind: 'quit',
      at: 1,
      sessions: [{ conversationId: 'c', startedAt: 1 }],
    });
    expect(existsSync(`${runningAtExitPath(dir)}.tmp`)).toBe(false);
    expect(() => JSON.parse(readFileSync(runningAtExitPath(dir), 'utf8'))).not.toThrow();
  });
});
