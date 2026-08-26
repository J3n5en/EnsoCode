import { describe, expect, it } from 'vitest';
import { parseAgentCommand, parseAgentWorkerEvent } from './agent';

describe('parseAgentCommand', () => {
  it('合法 spawn 命令原样通过', () => {
    const cmd = {
      type: 'spawn',
      sessionId: 's1',
      cwd: '/tmp',
      model: {
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'k',
        modelId: 'claude',
      },
    };
    expect(parseAgentCommand(cmd)).toEqual(cmd);
  });

  it('spawn 缺 model 字段时拒绝', () => {
    expect(
      parseAgentCommand({ type: 'spawn', sessionId: 's1', cwd: '/tmp', model: { api: 'ollama' } })
    ).toBeNull();
  });

  it('prompt 空文本拒绝', () => {
    expect(parseAgentCommand({ type: 'prompt', sessionId: 's1', text: '' })).toBeNull();
  });

  it('spawn-coworker 必填齐全通过,缺 name 拒绝', () => {
    const ok = {
      type: 'spawn-coworker',
      sessionId: 's1',
      coworkerId: 's1::cw-reviewer',
      name: 'reviewer',
    };
    expect(parseAgentCommand(ok)).toEqual(ok);
    expect(parseAgentCommand({ ...ok, resumeFile: '/tmp/a.jsonl' })).not.toBeNull();
    expect(parseAgentCommand({ ...ok, name: '' })).toBeNull();
    expect(parseAgentCommand({ ...ok, resumeFile: '' })).toBeNull();
  });

  it('dismiss-coworker 校验 sessionId 与 coworkerId', () => {
    expect(
      parseAgentCommand({ type: 'dismiss-coworker', sessionId: 's1', coworkerId: 'c1' })
    ).not.toBeNull();
    expect(parseAgentCommand({ type: 'dismiss-coworker', sessionId: 's1' })).toBeNull();
  });

  it('脏输入不崩：null、数组、未知类型都返回 null', () => {
    expect(parseAgentCommand(null)).toBeNull();
    expect(parseAgentCommand([])).toBeNull();
    expect(parseAgentCommand({ type: 'reboot' })).toBeNull();
    expect(parseAgentCommand('spawn')).toBeNull();
  });
});

describe('parseAgentWorkerEvent', () => {
  it('合法 status 事件通过', () => {
    const event = { type: 'status', sessionId: 's1', seq: 3, status: 'running' };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
  });

  it('status 值不在枚举内时拒绝', () => {
    expect(
      parseAgentWorkerEvent({ type: 'status', sessionId: 's1', seq: 1, status: 'waiting' })
    ).toBeNull();
  });

  it('message-upsert 的 index 为负数时拒绝', () => {
    expect(
      parseAgentWorkerEvent({
        type: 'message-upsert',
        sessionId: 's1',
        seq: 1,
        index: -1,
        message: { role: 'user', content: [] },
      })
    ).toBeNull();
  });

  it('turn-failed 必须带 error 文案', () => {
    expect(parseAgentWorkerEvent({ type: 'turn-failed', sessionId: 's1', seq: 2 })).toBeNull();
    expect(
      parseAgentWorkerEvent({ type: 'turn-failed', sessionId: 's1', seq: 2, error: 'boom' })
    ).not.toBeNull();
  });

  it('coworker-update 需要带 id 的 coworker 对象', () => {
    expect(
      parseAgentWorkerEvent({
        type: 'coworker-update',
        sessionId: 's1',
        seq: 1,
        coworker: { id: 's1::cw-x', name: 'x', status: 'idle', createdAt: 1 },
      })
    ).not.toBeNull();
    expect(
      parseAgentWorkerEvent({ type: 'coworker-update', sessionId: 's1', seq: 1, coworker: {} })
    ).toBeNull();
  });

  it('脏输入不崩', () => {
    expect(parseAgentWorkerEvent(undefined)).toBeNull();
    expect(parseAgentWorkerEvent(42)).toBeNull();
    expect(parseAgentWorkerEvent({ type: 'snapshot', sessions: 'nope' })).toBeNull();
  });
});
