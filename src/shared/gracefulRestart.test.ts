import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseRestartCheckpoint,
  type RestartCheckpoint,
  restartGate,
  takeRestartCheckpoint,
  writeRestartCheckpoint,
} from './gracefulRestart';

const checkpoint: RestartCheckpoint = {
  version: 1,
  pid: 42,
  writtenAt: 1,
  sessions: [
    {
      sessionId: 's1',
      generation: 'g1',
      sessionFile: '/tmp/s1.jsonl',
      seq: 7,
      nextStep: 'model-request',
      turnId: 't1',
      lastCompletedToolCallId: 'call-1',
      messageCount: 3,
      toolsInFlight: [],
    },
  ],
};

describe('restartGate', () => {
  it('工具在跑一律推迟，哪怕已到模型请求边界', () => {
    expect(
      restartGate({ toolsInFlight: ['a'], turnActive: true, atModelRequestBoundary: true })
    ).toEqual({ ready: false, reason: 'tool-in-flight' });
  });
  it('工具批结束、下一次模型请求之前：可以重启，下一步是模型请求', () => {
    expect(
      restartGate({ toolsInFlight: [], turnActive: true, atModelRequestBoundary: true })
    ).toEqual({ ready: true, nextStep: 'model-request' });
  });
  it('流式回复中途：等回合收口', () => {
    expect(
      restartGate({ toolsInFlight: [], turnActive: true, atModelRequestBoundary: false })
    ).toEqual({ ready: false, reason: 'turn-in-progress' });
  });
  it('空闲：立即重启，等用户下一条', () => {
    expect(
      restartGate({ toolsInFlight: [], turnActive: false, atModelRequestBoundary: false })
    ).toEqual({ ready: true, nextStep: 'await-user' });
  });
});

describe('restart checkpoint file', () => {
  it('写入后只能被接管一次，读到的就是写下的', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-restart-ckpt-'));
    const file = path.join(dir, 'restart-checkpoint.json');
    const archive = path.join(dir, 'restart-checkpoint.consumed.json');
    writeRestartCheckpoint(file, checkpoint);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(takeRestartCheckpoint(file, archive)).toEqual(checkpoint);
    expect(existsSync(file)).toBe(false);
    expect(JSON.parse(readFileSync(archive, 'utf8'))).toEqual(checkpoint);
    expect(takeRestartCheckpoint(file, archive)).toBeNull();
  });

  it('坏文件不接管', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-restart-ckpt-'));
    const file = path.join(dir, 'restart-checkpoint.json');
    writeFileSync(file, '{oops');
    expect(takeRestartCheckpoint(file, path.join(dir, 'a.json'))).toBeNull();
  });

  it('字段缺失或类型不对都拒绝', () => {
    const [entry] = checkpoint.sessions;
    expect(parseRestartCheckpoint(checkpoint)).toEqual(checkpoint);
    expect(parseRestartCheckpoint({ ...checkpoint, version: 2 })).toBeNull();
    expect(
      parseRestartCheckpoint({ ...checkpoint, sessions: [{ ...entry, nextStep: 'replay' }] })
    ).toBeNull();
    expect(parseRestartCheckpoint({ ...checkpoint, sessions: [{ ...entry, seq: -1 }] })).toBeNull();
    expect(
      parseRestartCheckpoint({ ...checkpoint, sessions: [{ ...entry, toolsInFlight: [1] }] })
    ).toBeNull();
    const { turnId: _turnId, ...missing } = entry;
    expect(parseRestartCheckpoint({ ...checkpoint, sessions: [missing] })).toBeNull();
  });
});
