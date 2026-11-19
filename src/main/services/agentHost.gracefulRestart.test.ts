import { tmpdir } from 'node:os';
import path from 'node:path';
import { RESTART_CHECKPOINT_ENV, RESTART_CHECKPOINT_FILE } from '@shared/gracefulRestart';
import type { AgentCommand } from '@shared/types/agent';
import { expect, it, vi } from 'vitest';

vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
const fork = vi.hoisted(() => ({
  posted: [] as Array<{ worker: number; message: unknown }>,
  envs: [] as Array<Record<string, string | undefined>>,
  children: [] as Array<{ emit(event: string, ...args: unknown[]): void; killed: number }>,
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir(),
    isPackaged: false,
    getVersion: () => '0.0.0',
    on: () => {},
  },
  notification: { isSupported: () => false },
  clipboard: { writeText: () => {} },
  shell: { openExternal: () => Promise.resolve() },
  utilityProcess: {
    fork: (_path: string, _args: string[], options: { env: Record<string, string> }) => {
      const index = fork.children.length;
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const child = {
        killed: 0,
        postMessage: (message: unknown) => fork.posted.push({ worker: index, message }),
        once: (event: string, handler: (...args: unknown[]) => void) =>
          handlers.set(event, handler),
        on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
        kill() {
          child.killed++;
        },
        emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
      };
      fork.envs.push(options.env);
      fork.children.push(child);
      return child;
    },
  },
}));
vi.mock('./processExit', () => ({
  killAndWaitExit: vi.fn(async (child: { kill(): void }) => child.kill()),
}));

import {
  requestGracefulWorkerRestart,
  sendAgentCommand,
  setAgentEventListener,
  startAgentWorker,
} from './agentHost';

const identity = { sessionId: 'session-1', generation: '11111111-1111-4111-8111-111111111111' };
const spawn: AgentCommand = {
  type: 'spawn-parent',
  identity,
  cwd: '/workspace',
  model: {
    api: 'openai-completions',
    baseUrl: 'https://example.test/v1',
    apiKey: 'fixture',
    modelId: 'm',
    settingsProviderId: 'p',
  },
};
const sessionFile = '/data/sessions/session-1.jsonl';
const types = (worker: number) =>
  fork.posted
    .filter((entry) => entry.worker === worker)
    .map((entry) => (entry.message as { type: string }).type);

it('菜单重启：没有会话明确返回 no-session；有会话只发一次请求，换代后按断点重建会话', () => {
  const events: unknown[] = [];
  setAgentEventListener((event) => events.push(event));
  startAgentWorker();
  fork.children[0].emit('spawn');

  expect(requestGracefulWorkerRestart()).toBe('no-session');
  expect(types(0)).not.toContain('graceful-restart');

  expect(sendAgentCommand(spawn)).toEqual({ ok: true });
  expect(requestGracefulWorkerRestart()).toBe('requested');
  expect(requestGracefulWorkerRestart()).toBe('already-restarting');
  expect(types(0).filter((type) => type === 'graceful-restart')).toHaveLength(1);

  // worker 在工具结束后落好断点
  fork.children[0].emit('message', {
    type: 'graceful-restart-ready',
    checkpoint: {
      version: 1,
      pid: 100,
      writtenAt: 1,
      sessions: [
        {
          sessionId: identity.sessionId,
          generation: identity.generation,
          sessionFile,
          seq: 12,
          nextStep: 'model-request',
          turnId: 'turn-1',
          lastCompletedToolCallId: 'call-1',
          messageCount: 3,
          toolsInFlight: [],
        },
      ],
    },
  });
  expect(fork.children[0].killed).toBe(1);
  expect(requestGracefulWorkerRestart()).toBe('already-restarting');

  // 换代窗口里的新命令不能投给正在退出的旧进程
  const before = fork.posted.length;
  sendAgentCommand({ type: 'prompt', identity, text: 'queued' });
  expect(fork.posted).toHaveLength(before);

  fork.children[0].emit('exit', 0);
  expect(events).not.toContainEqual(expect.objectContaining({ type: 'worker-exited' }));
  expect(fork.children).toHaveLength(2);
  expect(fork.envs[1][RESTART_CHECKPOINT_ENV]).toBe(
    path.join(tmpdir(), 'agent', RESTART_CHECKPOINT_FILE)
  );
  expect(fork.envs[0][RESTART_CHECKPOINT_ENV]).toBeUndefined();

  fork.children[1].emit('spawn');
  const replayed = fork.posted
    .filter((entry) => entry.worker === 1)
    .map((entry) => entry.message as AgentCommand)
    .filter((command) => command.type === 'spawn-parent' || command.type === 'prompt');
  expect(replayed).toEqual([
    { ...spawn, resumeFile: sessionFile },
    { type: 'prompt', identity, text: 'queued' },
  ]);

  // 新一代就绪后可以再次重启
  expect(requestGracefulWorkerRestart()).toBe('requested');
  expect(types(1).filter((type) => type === 'graceful-restart')).toHaveLength(1);
});
