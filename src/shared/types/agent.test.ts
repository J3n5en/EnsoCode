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

  it('脏输入不崩', () => {
    expect(parseAgentWorkerEvent(undefined)).toBeNull();
    expect(parseAgentWorkerEvent(42)).toBeNull();
    expect(parseAgentWorkerEvent({ type: 'snapshot', sessions: 'nope' })).toBeNull();
  });
});
