import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { liveActivity } from './liveActivity';

const user = (text = 'go'): ProjectedMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});
const call = (id: string, name: string, args: unknown): ProjectedMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: args }],
});
const result = (id: string, text: string, isError = false, ms?: number): ProjectedMessage => ({
  role: 'toolResult',
  toolCallId: id,
  isError,
  content: [{ type: 'text', text }],
  ...(ms === undefined ? {} : { toolDurationMs: ms }),
});
const session = (messages: ProjectedMessage[], extra = {}) => ({
  status: 'running' as const,
  messages,
  runStartedAt: 100,
  ...extra,
});

describe('liveActivity', () => {
  it('空闲且未排队时没有活动；排队时为 queued', () => {
    expect(liveActivity({ status: 'idle', messages: [] }, false)).toBeUndefined();
    expect(liveActivity(undefined, true)).toEqual({ state: 'queued', steps: [], more: 0 });
  });

  it('只取本轮最近 3 步，带状态、耗时与单行截断的参数摘要', () => {
    const long = `echo ${'x'.repeat(200)}\nsecond line`;
    const activity = liveActivity(
      session(
        [
          user('old'),
          call('old', 'read', { path: 'old.ts' }),
          result('old', 'ok'),
          user(),
          call('a', 'read', { path: 'a.ts' }),
          result('a', 'ok', false, 12),
          call('b', 'grep', { pattern: 'foo' }),
          result('b', 'boom', true, 30),
          call('c', 'bash', { command: 'rm -rf x' }),
          result('c', 'User denied this operation', true),
          call('d', 'bash', { command: long }),
        ],
        { toolStartedAt: { d: 500 } }
      ),
      false
    );
    expect(activity).toMatchObject({ state: 'tool', startedAt: 100, more: 1 });
    expect(activity?.steps.map(({ id, status }) => [id, status])).toEqual([
      ['b', 'error'],
      ['c', 'denied'],
      ['d', 'running'],
    ]);
    expect(activity?.steps[0]).toMatchObject({ name: 'grep', detail: 'foo', durationMs: 30 });
    expect(activity?.steps[2].startedAt).toBe(500);
    expect(activity?.steps[2].detail).toHaveLength(80);
    expect(activity?.steps[2].detail).toMatch(/^echo x+…$/);
  });

  it('按最后一条消息区分思考 / 输出 / 重试；运行中即使排队也看运行态', () => {
    const done = [user(), call('a', 'read', { path: 'a' }), result('a', 'ok')];
    expect(liveActivity(session(done), true)?.state).toBe('thinking');
    const typing: ProjectedMessage = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] };
    expect(liveActivity(session([...done, typing]), false)?.state).toBe('typing');
    const retry = { attempt: 1, maxAttempts: 3, delayMs: 1000, error: 'x', at: 1 };
    expect(liveActivity(session(done, { retry }), false)?.state).toBe('retrying');
  });
});

describe('liveActivity 等人超时', () => {
  it('审批 / 提问超时的工具结果记为 timeout，不当成用户拒绝', () => {
    const activity = liveActivity(
      session([
        user(),
        call('a', 'bash', { command: 'ls' }),
        result('a', '审批超时（10 分钟未处理）: auto-denied', true),
        call('b', 'ask_user', { question: 'q' }),
        result('b', '提问超时（10 分钟未回答）: no answer', true),
        call('c', 'bash', { command: 'rm x' }),
        result('c', 'User denied this operation', true),
      ]),
      false
    );
    expect(activity?.steps.map((step) => step.status)).toEqual(['timeout', 'timeout', 'denied']);
  });
});
