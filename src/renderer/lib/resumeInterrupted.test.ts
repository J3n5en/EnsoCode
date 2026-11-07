import { describe, expect, it, vi } from 'vitest';
import { type InterruptedConversation, resumeInterruptedSessions } from './resumeInterrupted';

function harness(initial: Record<string, InterruptedConversation>) {
  const conversations = { ...initial };
  const deps = {
    conversation: (id: string) => conversations[id],
    resume: vi.fn(async (id: string) => {
      conversations[id] = { ...conversations[id]!, started: true, spawning: false };
    }),
    retry: vi.fn(async () => ({ ok: true })),
    waitUntil: async (check: () => boolean) => check(),
  };
  return { deps, conversations };
}

describe('resumeInterruptedSessions', () => {
  it('未启动的先 resume，就绪后以 unfinishedOnly 续跑；返回成功续跑的 id', async () => {
    const { deps } = harness({
      a: { started: false, spawning: false, status: 'idle' },
      b: { started: true, spawning: false, status: 'idle' },
    });
    expect(await resumeInterruptedSessions(['a', 'b', 'missing'], deps)).toEqual(['a', 'b']);
    expect(deps.resume).toHaveBeenCalledTimes(1);
    expect(deps.retry).toHaveBeenCalledWith('a');
    expect(deps.retry).toHaveBeenCalledWith('b');
  });

  it('已在运行、等不到就绪、归档或 retry 失败的不计入', async () => {
    const { deps } = harness({
      running: { started: true, spawning: false, status: 'running' },
      stuck: { started: true, spawning: true, status: 'idle' },
      archived: { started: false, spawning: false, status: 'idle', archived: true },
      rejected: { started: true, spawning: false, status: 'idle' },
    });
    deps.retry.mockImplementation(async (id?: string) => ({ ok: id !== 'rejected' }));
    expect(
      await resumeInterruptedSessions(['running', 'stuck', 'archived', 'rejected'], deps)
    ).toEqual([]);
    expect(deps.resume).not.toHaveBeenCalled();
  });
});
