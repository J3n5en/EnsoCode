import type { RestartCheckpoint } from '@shared/gracefulRestart';
import type { AgentCommand } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { GracefulWorkerRestart } from './gracefulWorkerRestart';

const identity = { sessionId: 's1', generation: 'g1' };
const model = {
  api: 'openai-completions' as const,
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  modelId: 'model',
  settingsProviderId: 'provider',
};
const spawn: AgentCommand = { type: 'spawn-parent', identity, cwd: '/w', model };
const checkpoint = (sessions: RestartCheckpoint['sessions']): RestartCheckpoint => ({
  version: 1,
  pid: 1,
  writtenAt: 1,
  sessions,
});
const entry = {
  sessionId: 's1',
  generation: 'g1',
  sessionFile: '/data/sessions/s1.jsonl',
  seq: 9,
  nextStep: 'model-request' as const,
  turnId: 't1',
  lastCompletedToolCallId: 'call-1',
  messageCount: 3,
  toolsInFlight: [],
};

describe('GracefulWorkerRestart', () => {
  it('没有 worker 或 worker 里没有会话：明确返回 no-session，不发请求', () => {
    const restart = new GracefulWorkerRestart<object>();
    expect(restart.request(null)).toBe('no-session');
    expect(restart.request({})).toBe('no-session');
    expect(restart.pending).toBe(false);
  });

  it('重启进行中再请求：already-restarting，只换一次进程', () => {
    const worker = {};
    const restart = new GracefulWorkerRestart<object>();
    restart.record(spawn);
    expect(restart.request(worker)).toBe('requested');
    expect(restart.request(worker)).toBe('already-restarting');
    expect(restart.ready(worker, checkpoint([entry]))).toBe(true);
    expect(restart.request(worker)).toBe('already-restarting');
    expect(restart.ready(worker, checkpoint([entry]))).toBe(false);
    expect(restart.exited(worker)).toMatchObject({ swap: true });
    expect(restart.exited(worker)).toEqual({ swap: false });
  });

  it('换代时按断点重发 spawn（带 resumeFile）和之后的会话设置，凭据只在 Main 内存里', () => {
    const worker = {};
    const restart = new GracefulWorkerRestart<object>();
    restart.record(spawn);
    restart.record({ type: 'set-thinking', identity, level: 'low' });
    restart.record({ type: 'set-thinking', identity, level: 'high' });
    restart.record({ type: 'set-plan-mode', identity, active: true });
    restart.record({ type: 'prompt', identity, text: 'hi' } as AgentCommand);
    restart.request(worker);
    restart.ready(worker, checkpoint([entry]));
    const result = restart.exited(worker);
    expect(result).toEqual({
      swap: true,
      replay: [
        { ...spawn, resumeFile: entry.sessionFile },
        { type: 'set-thinking', identity, level: 'high' },
        { type: 'set-plan-mode', identity, active: true },
      ],
    });
    // 换代后的会话仍登记着：下一次重启照样可用
    expect(restart.request({})).toBe('requested');
  });

  it('会话结束或换代后不再重发旧代', () => {
    const worker = {};
    const restart = new GracefulWorkerRestart<object>();
    restart.record(spawn);
    restart.observe({ type: 'parent-ended', identity, seq: 3, reason: 'idle' });
    expect(restart.request(worker)).toBe('no-session');
    restart.record(spawn);
    restart.record({ ...spawn, identity: { sessionId: 's1', generation: 'g2' } } as AgentCommand);
    restart.request(worker);
    restart.ready(worker, checkpoint([entry]));
    expect(restart.exited(worker)).toEqual({ swap: true, replay: [] });
  });

  it('等待期间 worker 崩溃：按崩溃处理，会话登记清空', () => {
    const worker = {};
    const restart = new GracefulWorkerRestart<object>();
    restart.record(spawn);
    restart.request(worker);
    expect(restart.exited(worker)).toEqual({ swap: false });
    expect(restart.pending).toBe(false);
    expect(restart.request(worker)).toBe('no-session');
  });

  it('不是本次请求的 worker 发来的 ready 一律不认', () => {
    const restart = new GracefulWorkerRestart<object>();
    restart.record(spawn);
    restart.request({});
    expect(restart.ready({}, checkpoint([entry]))).toBe(false);
    expect(restart.ready({}, { sessions: 'bad' })).toBe(false);
  });
});
