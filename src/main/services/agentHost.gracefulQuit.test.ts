import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_WORKER_EXIT_LOG } from '@shared/agentWorkerExit';
import {
  RESTART_CHECKPOINT_ENV,
  RESTART_CHECKPOINT_FILE,
  type RestartCheckpoint,
} from '@shared/gracefulRestart';
import type { AgentCommand } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
const fork = vi.hoisted(() => ({
  userData: '',
  posted: [] as Array<{ worker: number; message: unknown }>,
  envs: [] as Array<Record<string, string | undefined>>,
  children: [] as Array<{ emit(event: string, ...args: unknown[]): void; killed: number }>,
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => fork.userData,
    getAppPath: () => fork.userData,
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
  cancelAgentQuitCheckpoint,
  prepareAgentWorkerForQuit,
  QUIT_CHECKPOINT_TIMEOUT_MS,
  rememberRestorableSpawn,
  sendAgentCommand,
  startAgentWorker,
  stopAgentWorker,
  stopAgentWorkerForQuit,
} from './agentHost';
import { loadColdRestartPlan, resumeColdRestartSessions } from './coldRestart';
import { findSecretLikeStrings, RESTART_MANIFEST_FILE } from './restartManifest';

const API_KEY = 'sk-live-0123456789abcdefghijklmnop';
const OAUTH_TOKEN = 'oauth-access-token-0123456789';
const identity = { sessionId: 'session-1', generation: '11111111-1111-4111-8111-111111111111' };
const sessionFile = '/data/sessions/session-1.jsonl';
const spawn = {
  type: 'spawn-parent',
  identity,
  cwd: '/workspace',
  resumeFile: sessionFile,
  model: {
    api: 'openai-completions',
    baseUrl: 'https://example.test/v1',
    apiKey: API_KEY,
    modelId: 'm',
    settingsProviderId: 'p',
    headers: { Authorization: `Bearer ${OAUTH_TOKEN}` },
  },
} as AgentCommand;
const checkpoint: RestartCheckpoint = {
  version: 1,
  pid: 100,
  writtenAt: 1_700_000_000_000,
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
};
const graceful = (worker: number) =>
  fork.posted.filter(
    (entry) =>
      entry.worker === worker && (entry.message as { type: string }).type === 'graceful-restart'
  );
const dataDir = () => path.join(fork.userData, 'agent');
const manifestFile = () => path.join(dataDir(), RESTART_MANIFEST_FILE);

/** 起一代 worker，登记一个普通根会话（spawn 请求 + 之后的设置） */
function bootWithSession(): number {
  startAgentWorker();
  const index = fork.children.length - 1;
  fork.children[index].emit('spawn');
  expect(sendAgentCommand(spawn)).toEqual({ ok: true });
  rememberRestorableSpawn(identity, {
    sessionId: identity.sessionId,
    providerId: 'p',
    modelId: 'm',
    cwd: '/workspace',
    resumeFile: sessionFile,
    thinkingLevel: 'low',
    approvalMode: 'full',
    // 混进请求的多余字段不能被写进清单
    ...({ apiKey: API_KEY } as object),
  });
  sendAgentCommand({ type: 'set-thinking', identity, level: 'high' });
  sendAgentCommand({ type: 'set-plan-mode', identity, active: true });
  return index;
}

beforeEach(() => {
  fork.userData = mkdtempSync(path.join(tmpdir(), 'enso-graceful-quit-'));
  mkdirSync(dataDir(), { recursive: true });
});

afterEach(() => {
  cancelAgentQuitCheckpoint();
  stopAgentWorker();
  vi.useRealTimers();
});

describe('应用退出走优雅重启', () => {
  it('没有正在跑的会话：不发请求、直接放行', async () => {
    const index = bootWithSession();
    await expect(
      prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: () => false })
    ).resolves.toBe('skipped');
    expect(graceful(index)).toHaveLength(0);
  });

  it('等 worker 到安全点后才放行；重复退出不叠加；清单落盘且没有密钥，冷启动据此续跑', async () => {
    const index = bootWithSession();
    let settled = false;
    const first = prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: () => true });
    void first.then(() => {
      settled = true;
    });
    const second = prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: () => true });
    expect(second).toBe(first);
    expect(graceful(index)).toHaveLength(1);
    await Promise.resolve();
    expect(settled).toBe(false);

    // worker 落好断点（产品里由 supervisor 写到 dataDir/restart-checkpoint.json）
    writeFileSync(path.join(dataDir(), RESTART_CHECKPOINT_FILE), JSON.stringify(checkpoint));
    fork.children[index].emit('message', { type: 'graceful-restart-ready', checkpoint });
    await expect(first).resolves.toBe('checkpointed');
    // 退出不换代：不自己杀进程换新的，交给 stopAgentWorkerForQuit 收尾
    expect(fork.children[index].killed).toBe(0);
    await stopAgentWorkerForQuit(100);
    fork.children[index].emit('exit', 0);
    expect(fork.children).toHaveLength(index + 1);

    const raw = readFileSync(manifestFile(), 'utf8');
    expect(findSecretLikeStrings(raw, [API_KEY, OAUTH_TOKEN])).toEqual([]);
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain(OAUTH_TOKEN);
    expect(raw).not.toMatch(/apiKey|headers|token|Bearer/i);
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      reason: 'quit',
      writtenAt: expect.any(Number),
      checkpointWrittenAt: checkpoint.writtenAt,
      sessions: [
        {
          sessionId: identity.sessionId,
          generation: identity.generation,
          sessionFile,
          settings: {
            providerId: 'p',
            modelId: 'm',
            cwd: '/workspace',
            thinkingLevel: 'high',
            approvalMode: 'full',
            planMode: true,
          },
          turnId: 'turn-1',
          nextStep: 'model-request',
          lastCompletedToolCallId: 'call-1',
          seq: 12,
        },
      ],
    });

    // 冷启动：新 Main 读清单 + 配套断点，第一代 worker 带断点启动，按清单重走 spawn
    stopAgentWorker();
    const plan = loadColdRestartPlan(dataDir());
    expect(plan?.resume.map((entry) => entry.sessionId)).toEqual([identity.sessionId]);
    startAgentWorker({ restartCheckpointFile: plan?.checkpointFile });
    expect(fork.envs.at(-1)?.[RESTART_CHECKPOINT_ENV]).toBe(
      path.join(dataDir(), RESTART_CHECKPOINT_FILE)
    );
    const resumed: unknown[] = [];
    await resumeColdRestartSessions(plan!, async (entry) => {
      resumed.push(entry);
      return { ok: true };
    });
    expect(resumed).toEqual([
      expect.objectContaining({
        sessionId: identity.sessionId,
        generation: identity.generation,
        sessionFile,
        turnId: 'turn-1',
        lastCompletedToolCallId: 'call-1',
        settings: expect.objectContaining({ providerId: 'p', modelId: 'm', planMode: true }),
      }),
    ]);
    // 清单只恢复一次
    expect(loadColdRestartPlan(dataDir())).toBeNull();
  });

  it('等太久：超时照常放行，并记一条日志', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = bootWithSession();
    let done = false;
    const pending = prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: () => true });
    void pending.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(QUIT_CHECKPOINT_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('timeout');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${QUIT_CHECKPOINT_TIMEOUT_MS}ms`));
    expect(readFileSync(path.join(dataDir(), AGENT_WORKER_EXIT_LOG), 'utf8')).toContain('照常退出');
    expect(graceful(index)).toHaveLength(1);
    // 超时后再触发退出：拿同一个结果，不再发第二次请求
    await expect(
      prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: () => true })
    ).resolves.toBe('timeout');
    expect(graceful(index)).toHaveLength(1);
    warn.mockRestore();
  });

  it('更新没装成：撤掉清单，worker 按断点换代接着跑', async () => {
    const index = bootWithSession();
    const pending = prepareAgentWorkerForQuit({ reason: 'update', hasRunningSessions: () => true });
    fork.children[index].emit('message', { type: 'graceful-restart-ready', checkpoint });
    await expect(pending).resolves.toBe('checkpointed');
    expect(JSON.parse(readFileSync(manifestFile(), 'utf8')).reason).toBe('update');
    cancelAgentQuitCheckpoint();
    expect(() => readFileSync(manifestFile())).toThrow();
    await vi.waitFor(() => expect(fork.children[index].killed).toBe(1));
    fork.children[index].emit('exit', 0);
    expect(fork.children).toHaveLength(index + 2);
    expect(fork.envs.at(-1)?.[RESTART_CHECKPOINT_ENV]).toBe(
      path.join(dataDir(), RESTART_CHECKPOINT_FILE)
    );
  });
});
