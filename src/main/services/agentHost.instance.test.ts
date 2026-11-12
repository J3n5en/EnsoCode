import { tmpdir } from 'node:os';
import { type AgentCommand, parseAgentCommand } from '@shared/types/agent';
import { model } from '@shared/types/agent.testUtils';
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
  agentWorkerAlive,
  promptSession,
  releaseParentSession,
  rememberParentInstance,
  retrySession,
  sendAgentCommand,
  startAgentWorker,
  steerSession,
} from './agentHost';

const parent = { sessionId: 'parent', generation: '11111111-1111-4111-8111-111111111111' };
const other = { sessionId: 'other', generation: '22222222-2222-4222-8222-222222222222' };
const child = {
  sessionId: 'parent::cw',
  generation: '33333333-3333-4333-8333-333333333333',
  parent,
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  instanceName: 'cw',
  typeKey: 'builtin:worker',
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

/** 本文件的用例共享模块级 worker 状态：取一个已 spawn 的 worker，不依赖前序用例留下什么 */
function liveWorker() {
  if (!agentWorkerAlive()) startAgentWorker();
  const live = fork.children[fork.children.length - 1];
  live.emit('spawn');
  return live;
}

// 真实场景：worker 崩溃后对之前跑过的会话「移到 / 清理 worktree」，卡 8 秒报 release timed out，还白白拉起新 worker
it('worker 崩溃后释放旧会话：立即成功，不重启 worker、不空等超时', async () => {
  vi.useFakeTimers();
  try {
    liveWorker().emit('exit');
    const forks = fork.children.length;
    let result: unknown = 'pending';
    void releaseParentSession(parent).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual({ ok: true });
    expect(fork.children).toHaveLength(forks);
  } finally {
    vi.useRealTimers();
  }
});

// 真实场景：release-parent 已发给 worker，parent-ended 回来前 worker 崩溃；会话树随进程销毁，不该再等 8 秒超时
it('release 等回执期间 worker 退出：立即唤醒等待者', async () => {
  vi.useFakeTimers();
  try {
    const live = liveWorker();
    let result: unknown = 'pending';
    void releaseParentSession(parent).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe('pending');
    live.emit('exit');
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual({ ok: true });
  } finally {
    vi.useRealTimers();
  }
});

// 短路的边界：积压里已有该会话的 spawn-parent 时 worker 起来后会建出它，提前报成功会让旧 cwd 的会话被同代复用
it('worker 未 spawn 时积压了该会话的 spawn-parent：release 照常排在其后，等 parent-ended 才成功', async () => {
  vi.useFakeTimers();
  try {
    liveWorker().emit('exit');
    // 必须是能通过 worker 协议校验的完整命令：sendAgentCommand 会先校验，不合法的不进积压队列
    const spawnParent = parseAgentCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd: '/old',
      model,
    });
    if (!spawnParent) throw new Error('spawn-parent 夹具不满足 worker 协议');
    expect(sendAgentCommand(spawnParent)).toEqual({ ok: true });
    let result: unknown = 'pending';
    void releaseParentSession(parent).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe('pending');
    const next = fork.children[fork.children.length - 1];
    fork.posted.length = 0;
    next.emit('spawn');
    expect(
      (fork.posted as AgentCommand[])
        .map((command) => command.type)
        .filter((type) => type === 'spawn-parent' || type === 'release-parent')
    ).toEqual(['spawn-parent', 'release-parent']);
    next.emit('message', { type: 'parent-ended', identity: parent, seq: 1, reason: 'released' });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual({ ok: true });
  } finally {
    vi.useRealTimers();
  }
});
