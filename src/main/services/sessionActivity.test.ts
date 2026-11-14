import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_COMMAND_MAX, projectSessionActivity } from './sessionActivity';

const call = (id: string, name: string, args?: unknown, timestamp = 1_000): ProjectedMessage => ({
  role: 'assistant',
  timestamp,
  content: [{ type: 'toolCall', id, name, ...(args === undefined ? {} : { arguments: args }) }],
});

const result = (
  toolCallId: string,
  options: { isError?: boolean; durationMs?: number; timestamp?: number; text?: string } = {}
): ProjectedMessage => ({
  role: 'toolResult',
  toolCallId,
  isError: options.isError,
  toolDurationMs: options.durationMs,
  timestamp: options.timestamp,
  content: [{ type: 'text', text: options.text ?? 'SECRET OUTPUT' }],
});

describe('projectSessionActivity', () => {
  it('给出工具名、成败、耗时与时间，且不带任何工具输出', () => {
    const activity = projectSessionActivity([
      call('c1', 'bash', { command: 'pnpm typecheck' }, 1_000),
      result('c1', { durationMs: 42, timestamp: 1_042 }),
      call('c2', 'read', { path: '/a.ts' }, 2_000),
      result('c2', { isError: true, durationMs: 5, timestamp: 2_005 }),
    ]);
    expect(activity).toEqual([
      { name: 'bash', ok: true, durationMs: 42, at: 1_042, command: 'pnpm typecheck' },
      { name: 'read', ok: false, durationMs: 5, at: 2_005 },
    ]);
    expect(JSON.stringify(activity)).not.toContain('SECRET OUTPUT');
  });

  it('没有 toolResult 的调用标 pending，不当成失败', () => {
    const activity = projectSessionActivity([call('c1', 'bash', { command: 'sleep 999' }, 7_000)]);
    expect(activity).toEqual([
      { name: 'bash', ok: false, pending: true, at: 7_000, command: 'sleep 999' },
    ]);
  });

  it('命令摘要截到上限，非命令参数不外泄', () => {
    const long = 'x'.repeat(ACTIVITY_COMMAND_MAX + 50);
    const activity = projectSessionActivity([
      call('c1', 'bash', { command: long }),
      call('c2', 'read', { path: '/secret/path.ts', content: 'body' }),
    ]);
    expect(activity[0]?.command).toBe(`${'x'.repeat(ACTIVITY_COMMAND_MAX)}…`);
    expect(activity[1]).toEqual({ name: 'read', ok: false, pending: true, at: 1_000 });
  });

  it('只保留最近 limit 个调用', () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
      call(`c${index}`, 'bash', { command: `cmd-${index}` })
    );
    const activity = projectSessionActivity(messages, 5);
    expect(activity.map((item) => item.command)).toEqual([
      'cmd-25',
      'cmd-26',
      'cmd-27',
      'cmd-28',
      'cmd-29',
    ]);
  });
});
