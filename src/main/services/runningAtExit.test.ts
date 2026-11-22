import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRunningAtExit,
  createExitRecorder,
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

  it('同一次退出 before-quit 来两次：第二次回合已被停掉，不删第一次记下的在跑会话，心跳停掉', () => {
    let running = [{ conversationId: 'c1', turnId: 't1', startedAt: 5 }];
    let heartbeatStopped = 0;
    const recorder = createExitRecorder({
      dir,
      pid: 7,
      snapshot: () => running,
      committed: () => true,
      now: () => 900,
      stopHeartbeat: () => heartbeatStopped++,
    });
    recorder.record('update');
    running = [];
    recorder.record('update');
    expect(readRunningAtExit(dir)).toMatchObject({
      pid: 7,
      kind: 'update',
      sessions: [{ conversationId: 'c1', turnId: 't1' }],
    });
    expect(heartbeatStopped).toBeGreaterThan(0);
  });

  it('退出被拦下（确认框取消）：不锁定记录、不停心跳，之后的快照照常覆盖', () => {
    let running = [{ conversationId: 'c1', startedAt: 5 }];
    let committed = false;
    let heartbeatStopped = 0;
    const recorder = createExitRecorder({
      dir,
      pid: 7,
      snapshot: () => running,
      committed: () => committed,
      stopHeartbeat: () => heartbeatStopped++,
    });
    recorder.record('quit');
    expect(heartbeatStopped).toBe(0);
    running = [];
    committed = true;
    recorder.record('quit');
    expect(existsSync(runningAtExitPath(dir))).toBe(false);
  });

  it('退出时本来就没有在跑的会话：照旧清掉旧记录', () => {
    writeRunningAtExit(dir, {
      pid: 1,
      kind: 'quit',
      at: 1,
      sessions: [{ conversationId: 'old', startedAt: 1 }],
    });
    const recorder = createExitRecorder({
      dir,
      pid: 7,
      snapshot: () => [],
      committed: () => true,
      now: () => 2,
    });
    recorder.record('quit');
    expect(existsSync(runningAtExitPath(dir))).toBe(false);
  });
});
