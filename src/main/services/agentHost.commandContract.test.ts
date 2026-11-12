import { tmpdir } from 'node:os';
import type { AgentCommand } from '@shared/types/agent';
import { expect, it, vi } from 'vitest';

vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
const fork = vi.hoisted(() => ({
  posted: [] as unknown[],
  children: [] as Array<{ emit(event: string, ...args: unknown[]): void }>,
}));
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => tmpdir(), isPackaged: false },
  utilityProcess: {
    fork: () => {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const child = {
        postMessage: (message: unknown) => fork.posted.push(message),
        once: (event: string, handler: (...args: unknown[]) => void) =>
          handlers.set(event, handler),
        on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
        kill: () => {},
        emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
      };
      fork.children.push(child);
      return child;
    },
  },
}));
vi.mock('../ipc/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc/settings')>()),
  readSettings: () => undefined,
}));

import { sendAgentCommand, startAgentWorker } from './agentHost';

it('worker 解析不了的命令在 Main 当场拒绝并带命令类型，不再发给 worker', () => {
  startAgentWorker();
  fork.children[0].emit('spawn');
  fork.posted.splice(0);
  const identity = { sessionId: 'parent', generation: '11111111-1111-4111-8111-111111111111' };
  const result = sendAgentCommand({
    type: 'spawn-parent',
    identity,
    cwd: '/repo',
    subagentModels: [{ name: 'x' }],
  } as unknown as AgentCommand);
  expect(result.ok).toBe(false);
  expect(result.error).toContain('spawn-parent');
  expect(fork.posted).toEqual([]);
});
