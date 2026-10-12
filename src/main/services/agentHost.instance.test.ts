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

import {
  promptSession,
  rememberParentInstance,
  retrySession,
  startAgentWorker,
  steerSession,
} from './agentHost';

const parent = { sessionId: 'parent', generation: '11111111-1111-4111-8111-111111111111' };
const other = { sessionId: 'other', generation: '22222222-2222-4222-8222-222222222222' };
const child = {
  sessionId: 'parent::cw',
  generation: '33333333-3333-4333-8333-333333333333',
  parent,
};
const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const sessionCommands = () =>
  (fork.posted.splice(0) as AgentCommand[])
    .filter((command) => ['prompt', 'steer', 'retry'].includes(command.type))
    .map((command) => ({
      type: command.type,
      sessionId: (command as { identity: { sessionId: string } }).identity.sessionId,
      instanceId: (command as { instanceId?: string }).instanceId,
    }));

it('阶段13：prompt / steer / retry 自动带上该父会话最近一次 spawn 登记的实例号；子会话、未登记、改绑为空与 worker 退出后不带', () => {
  rememberParentInstance(parent.sessionId, first);
  promptSession(parent, 'hi');
  steerSession(parent, 'more', undefined, 'd-1', true);
  retrySession(parent);
  promptSession(child as unknown as typeof parent, 'tab');
  promptSession(other, 'hi');
  startAgentWorker();
  fork.children[0].emit('spawn');
  expect(sessionCommands()).toEqual([
    { type: 'prompt', sessionId: 'parent', instanceId: first },
    { type: 'steer', sessionId: 'parent', instanceId: first },
    { type: 'retry', sessionId: 'parent', instanceId: first },
    { type: 'prompt', sessionId: 'parent::cw', instanceId: undefined },
    { type: 'prompt', sessionId: 'other', instanceId: undefined },
  ]);
  rememberParentInstance(parent.sessionId, second);
  promptSession(parent, 'again');
  rememberParentInstance(parent.sessionId, undefined);
  promptSession(parent, 'desktop');
  expect(sessionCommands()).toEqual([
    { type: 'prompt', sessionId: 'parent', instanceId: second },
    { type: 'prompt', sessionId: 'parent', instanceId: undefined },
  ]);
  rememberParentInstance(parent.sessionId, second);
  fork.children[0].emit('exit');
  promptSession(parent, 'after exit');
  fork.children[1].emit('spawn');
  expect(sessionCommands()).toEqual([
    { type: 'prompt', sessionId: 'parent', instanceId: undefined },
  ]);
});
