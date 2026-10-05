import type { ProjectedMessage, RendererAgentEvent } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { BotActivityTracker } from './activityTracker';

const identity = (sessionId: string) => ({ sessionId, generation: 'g' });
const ev = (sessionId: string, event: Record<string, unknown>) =>
  ({ seq: 1, identity: identity(sessionId), ...event }) as unknown as RendererAgentEvent;
const user = (text: string): ProjectedMessage =>
  ({ role: 'user', content: [{ type: 'text', text }] }) as ProjectedMessage;
const call = (id: string, command: string): ProjectedMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'bash', arguments: { command } }],
  }) as ProjectedMessage;
const result = (id: string, isError = false): ProjectedMessage =>
  ({
    role: 'toolResult',
    toolCallId: id,
    isError,
    toolDurationMs: 1200,
    content: [{ type: 'text', text: 'ok' }],
  }) as ProjectedMessage;

function tracker(now = { t: 1000 }) {
  return { now, t: new BotActivityTracker(() => now.t) };
}

describe('BotActivityTracker', () => {
  it('运行中的会话给出状态、开始时间与本轮最近工具步骤；空闲时消失', () => {
    const { now, t } = tracker();
    t.apply(ev('s1', { type: 'status', status: 'running' }));
    t.apply(ev('s1', { type: 'message-upsert', index: 0, message: user('hi') }));
    expect(t.list()).toEqual([
      {
        conversationId: 's1',
        activity: { state: 'thinking', startedAt: 1000, steps: [], more: 0 },
      },
    ]);
    now.t = 3000;
    t.apply(ev('s1', { type: 'message-upsert', index: 1, message: call('c1', 'ls -la') }));
    t.apply(ev('s1', { type: 'tool-output', toolCallId: 'c1', output: '', startedAt: 2500 }));
    expect(t.list()[0].activity).toMatchObject({
      state: 'tool',
      steps: [{ id: 'c1', name: 'bash', detail: 'ls -la', status: 'running', startedAt: 2500 }],
    });
    t.apply(ev('s1', { type: 'message-upsert', index: 2, message: result('c1') }));
    expect(t.list()[0].activity.steps[0]).toMatchObject({ status: 'done', durationMs: 1200 });
    t.apply(ev('s1', { type: 'turn-completed', turnId: 't' }));
    expect(t.list()).toEqual([]);
  });

  it('新一轮 user 消息丢弃上一轮步骤；重试中为 retrying，失败与 idle 都清掉', () => {
    const { t } = tracker();
    t.apply(ev('s1', { type: 'status', status: 'running' }));
    t.apply(ev('s1', { type: 'message-upsert', index: 0, message: user('a') }));
    t.apply(ev('s1', { type: 'message-upsert', index: 1, message: call('c1', 'one') }));
    t.apply(ev('s1', { type: 'message-upsert', index: 2, message: result('c1') }));
    t.apply(ev('s1', { type: 'message-upsert', index: 3, message: user('b') }));
    expect(t.list()[0].activity.steps).toEqual([]);
    t.apply(ev('s1', { type: 'turn-retry', attempt: 1, maxAttempts: 3, delayMs: 10, error: 'x' }));
    expect(t.list()[0].activity.state).toBe('retrying');
    t.apply(ev('s1', { type: 'status', status: 'running' }));
    expect(t.list()[0].activity.state).toBe('thinking');
    t.apply(ev('s1', { type: 'turn-failed', turnId: 't', error: 'boom' }));
    expect(t.list()).toEqual([]);
    t.apply(ev('s2', { type: 'status', status: 'running' }));
    t.apply(ev('s2', { type: 'status', status: 'idle' }));
    expect(t.list()).toEqual([]);
  });

  it('只跟踪 accept 认可的会话；快照里正在跑的会话补齐本轮消息', () => {
    const t = new BotActivityTracker(
      () => 5,
      (id) => id !== 'code'
    );
    t.apply(ev('code', { type: 'status', status: 'running' }));
    t.apply({
      type: 'snapshot',
      sessions: [
        {
          identity: identity('s3'),
          status: 'running',
          baseIndex: 10,
          messages: [call('old', 'x'), user('go'), call('c2', 'pwd')],
          commands: [],
        },
        { identity: identity('s4'), status: 'idle', messages: [], commands: [] },
      ],
    } as unknown as RendererAgentEvent);
    expect(t.list()).toEqual([
      {
        conversationId: 's3',
        activity: {
          state: 'tool',
          startedAt: 5,
          steps: [{ id: 'c2', name: 'bash', detail: 'pwd', status: 'running' }],
          more: 0,
        },
      },
    ]);
  });

  it('未在跑的会话收到消息不出现', () => {
    const { t } = tracker();
    t.apply(ev('s1', { type: 'message-upsert', index: 0, message: user('late') }));
    t.apply(ev('s1', { type: 'turn-retry', attempt: 1, maxAttempts: 3, delayMs: 10, error: 'x' }));
    expect(t.list()).toEqual([]);
  });

  it('forget 移除会话；worker 退出全部清空', () => {
    const { t } = tracker();
    t.apply(ev('s1', { type: 'status', status: 'running' }));
    t.apply(ev('s2', { type: 'status', status: 'running' }));
    t.forget('s1');
    expect(t.list().map((item) => item.conversationId)).toEqual(['s2']);
    t.apply({ type: 'worker-exited' } as RendererAgentEvent);
    expect(t.list()).toEqual([]);
  });
});
