import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_WORKER_EXIT_LOG } from '@shared/agentWorkerExit';
import { setAppLoggingEnabled } from '@shared/appLogFile';
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
  DETACH_ACK_TIMEOUT_MS,
  forceAgentWorkerQuit,
  prepareAgentWorkerForQuit,
  QUIT_REPLY_IDLE_MS,
  QUIT_REPLY_WAIT_CAP_MS,
  QUIT_REPLY_WAIT_FLOOR_MS,
  QUIT_TOOL_WAIT_LIMIT_MS,
  rememberRestorableSpawn,
  requestGracefulWorkerRestart,
  resumesAfterQuit,
  sendAgentCommand,
  setAgentEventListener,
  startAgentWorker,
  stopAgentWorker,
  stopAgentWorkerForQuit,
} from './agentHost';
import { loadColdRestartPlan, resumeColdRestartSessions } from './coldRestart';
import { killAndWaitExit } from './processExit';
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
const deferred = (toolsInFlight: string[], reason = 'tool-in-flight') => ({
  type: 'graceful-restart-deferred',
  sessions: [{ identity, reason, toolsInFlight }],
});
/** 回复在写：带这次请求的出 token 时刻 */
const writing = (reply: {
  requestStartMs: number;
  firstTokenMs?: number;
  lastOutputMs?: number;
}) => ({
  type: 'graceful-restart-deferred',
  sessions: [{ identity, reason: 'turn-in-progress', toolsInFlight: [], reply }],
});
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
  setAppLoggingEnabled(true);
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
    // 退出收尾期间还有命令进来（渲染层 / 秘书）：不再拉起新 worker 去认回刚交出的后台命令
    sendAgentCommand({ type: 'set-thinking', identity, level: 'low' });
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

  it('没有工具在跑却等不到安全点：不多等，超时照常放行，并记一条日志', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = bootWithSession();
    let done = false;
    const pending = prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: () => true });
    void pending.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(QUIT_REPLY_WAIT_FLOOR_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('timeout');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`停止出 token 超过 ${QUIT_REPLY_IDLE_MS}ms`)
    );
    expect(readFileSync(path.join(dataDir(), AGENT_WORKER_EXIT_LOG), 'utf8')).toContain('照常退出');
    expect(readFileSync(path.join(dataDir(), AGENT_WORKER_EXIT_LOG), 'utf8')).toContain(
      'worker 没报告推迟（可能卡在会话打开或 worker 无响应）'
    );
    expect(graceful(index)).toHaveLength(1);
    // 超时后再触发退出：拿同一个结果，不再发第二次请求
    await expect(
      prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: () => true })
    ).resolves.toBe('timeout');
    expect(graceful(index)).toHaveLength(1);
    warn.mockRestore();
  });

  it('有工具在跑：提示在等、不会 10 秒就退，工具结束落断点后才放行并写清单', async () => {
    vi.useFakeTimers();
    const index = bootWithSession();
    const waiting = vi.fn();
    let done = false;
    const pending = prepareAgentWorkerForQuit({
      reason: 'quit',
      hasRunningSessions: () => true,
      onWaitingForTools: waiting,
    });
    void pending.then(() => {
      done = true;
    });
    fork.children[index].emit('message', deferred(['call-1']));
    expect(waiting).toHaveBeenCalledTimes(1);
    // 后加入的等待者（will-quit 收尾）拿同一个结果；已在等工具就立即告诉它
    const joined = vi.fn();
    expect(
      prepareAgentWorkerForQuit({
        reason: 'quit',
        hasRunningSessions: () => true,
        onWaitingForTools: joined,
      })
    ).toBe(pending);
    expect(joined).toHaveBeenCalledTimes(1);
    expect(joined).toHaveBeenLastCalledWith('tool', [
      { sessionId: identity.sessionId, kind: 'background' },
    ]);

    await vi.advanceTimersByTimeAsync(QUIT_REPLY_WAIT_FLOOR_MS * 3);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(
      QUIT_TOOL_WAIT_LIMIT_MS - QUIT_REPLY_WAIT_FLOOR_MS * 3 - 1_000
    );
    expect(done).toBe(false);
    expect(graceful(index)).toHaveLength(1);

    // 命令跑完、停在下一次模型请求前落了断点
    writeFileSync(path.join(dataDir(), RESTART_CHECKPOINT_FILE), JSON.stringify(checkpoint));
    fork.children[index].emit('message', { type: 'graceful-restart-ready', checkpoint });
    await expect(pending).resolves.toBe('checkpointed');
    expect(waiting).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(manifestFile(), 'utf8')).sessions).toHaveLength(1);
    expect(resumesAfterQuit(identity.sessionId)).toBe(true);
  });

  it('换代重启已在等工具时再退出 / 安装更新：照样开等待层、按等工具的上限等，不当成没工具超时', async () => {
    vi.useFakeTimers();
    const index = bootWithSession();
    expect(requestGracefulWorkerRestart()).toBe('requested');
    fork.children[index].emit('message', deferred(['call-1']));
    const waiting = vi.fn();
    let done = false;
    void prepareAgentWorkerForQuit({
      reason: 'update',
      hasRunningSessions: () => true,
      onWaitingForTools: waiting,
    }).then(() => {
      done = true;
    });
    expect(waiting).toHaveBeenCalledExactlyOnceWith('tool', [
      { sessionId: identity.sessionId, kind: 'background' },
    ]);
    await vi.advanceTimersByTimeAsync(QUIT_REPLY_WAIT_FLOOR_MS * 3);
    expect(done).toBe(false);
  });

  it('工具结束后没工具在跑：只再等一小段，不等满上限', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = bootWithSession();
    const pending = prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: () => true });
    fork.children[index].emit('message', deferred(['call-1']));
    await vi.advanceTimersByTimeAsync(60_000);
    fork.children[index].emit('message', deferred([], 'turn-in-progress'));
    await vi.advanceTimersByTimeAsync(QUIT_REPLY_WAIT_FLOOR_MS);
    await expect(pending).resolves.toBe('timeout');
    warn.mockRestore();
  });

  it('回复在写、没有工具在跑：告诉弹层在等回复，等到回复写完（不到上限不中止），落断点后放行', async () => {
    vi.useFakeTimers();
    const index = bootWithSession();
    const waiting = vi.fn();
    let done = false;
    const pending = prepareAgentWorkerForQuit({
      reason: 'update',
      hasRunningSessions: () => true,
      onWaitingForTools: waiting,
    });
    void pending.then(() => {
      done = true;
    });
    fork.children[index].emit('message', deferred([], 'turn-in-progress'));
    expect(waiting).toHaveBeenCalledExactlyOnceWith('reply', [
      { sessionId: identity.sessionId, kind: 'turn' },
    ]);
    // 以前 10 秒就中止正在写的回复；现在要等它写完
    await vi.advanceTimersByTimeAsync(QUIT_REPLY_WAIT_FLOOR_MS - 1_000);
    expect(done).toBe(false);
    // 子会话不进清单：日志标成子会话，不能只截 id 前 8 位而看着像父会话
    const child = {
      ...checkpoint.sessions[0],
      sessionId: `${identity.sessionId}::cw-reviewer`,
      nextStep: 'await-user' as const,
      turnId: null,
      lastCompletedToolCallId: null,
    };
    fork.children[index].emit('message', {
      type: 'graceful-restart-ready',
      checkpoint: { ...checkpoint, sessions: [...checkpoint.sessions, child] },
    });
    await expect(pending).resolves.toBe('checkpointed');
    const log = readFileSync(path.join(dataDir(), AGENT_WORKER_EXIT_LOG), 'utf8');
    expect(log).toContain(
      'update: 到安全点，恢复清单 1 个会话：session-=model-request（冷启动续跑） cw-revie(子会话)=不进清单'
    );
  });

  it('回复写太久超时：日志写明每个会话退出时在干什么，按收尾落的断点写清单并逐个记下处理结果', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = bootWithSession();
    const pending = prepareAgentWorkerForQuit({ reason: 'update', hasRunningSessions: () => true });
    fork.children[index].emit('message', deferred([], 'turn-in-progress'));
    await vi.advanceTimersByTimeAsync(QUIT_REPLY_WAIT_FLOOR_MS);
    await expect(pending).resolves.toBe('timeout');
    vi.mocked(killAndWaitExit).mockImplementationOnce(async (child) => {
      child.kill();
      // worker 收尾中止回复后把这一轮记成 model-request
      writeCheckpoint({ ...checkpoint, writtenAt: Date.now() });
    });
    await stopAgentWorkerForQuit(100);
    const log = readFileSync(path.join(dataDir(), AGENT_WORKER_EXIT_LOG), 'utf8');
    expect(log).toContain(`停止出 token 超过 ${QUIT_REPLY_IDLE_MS}ms`);
    expect(log).toContain('会话状态：session-=回合收尾中');
    expect(log).toContain('session-=model-request（冷启动续跑）');
    expect(loadColdRestartPlan(dataDir())?.resume.map((entry) => entry.sessionId)).toEqual([
      identity.sessionId,
    ]);
    warn.mockRestore();
  });

  it('挡住的会话变了再回调；超时日志写清工具名、子会话和打开中的会话', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = bootWithSession();
    const waiting = vi.fn();
    const pending = prepareAgentWorkerForQuit({
      reason: 'quit',
      hasRunningSessions: () => true,
      onWaitingForTools: waiting,
    });
    const childId = `${identity.sessionId}::child-99`;
    const bash = {
      type: 'graceful-restart-deferred',
      sessions: [
        {
          identity,
          reason: 'tool-in-flight',
          toolsInFlight: ['call-1'],
          toolNames: ['bash', 'bash'],
        },
      ],
    };
    fork.children[index].emit('message', bash);
    expect(waiting).toHaveBeenCalledExactlyOnceWith('tool', [
      { sessionId: identity.sessionId, kind: 'tool', tools: ['bash'] },
    ]);
    fork.children[index].emit('message', bash);
    expect(waiting).toHaveBeenCalledTimes(1);
    fork.children[index].emit('message', {
      type: 'graceful-restart-deferred',
      sessions: [
        {
          identity,
          reason: 'tool-in-flight',
          toolsInFlight: ['call-1'],
          toolNames: ['bash'],
        },
        {
          identity: { ...identity, sessionId: childId },
          reason: 'tool-in-flight',
          toolsInFlight: ['call-2'],
          toolNames: ['bash'],
        },
        {
          identity: { ...identity, sessionId: 'opening-1' },
          reason: 'session-starting',
          toolsInFlight: [],
        },
        {
          identity: { ...identity, sessionId: 'replying' },
          reason: 'turn-in-progress',
          toolsInFlight: [],
          reply: { requestStartMs: 1 },
        },
        {
          identity: { ...identity, sessionId: 'backing1' },
          reason: 'tool-in-flight',
          toolsInFlight: ['task-9'],
        },
        {
          identity: { ...identity, sessionId: 'turning1' },
          reason: 'turn-in-progress',
          toolsInFlight: [],
        },
      ],
    });
    expect(waiting).toHaveBeenLastCalledWith('tool', [
      { sessionId: identity.sessionId, kind: 'tool', tools: ['bash'] },
      { sessionId: childId, kind: 'tool', tools: ['bash'] },
      { sessionId: 'opening-1', kind: 'starting' },
      { sessionId: 'replying', kind: 'reply' },
      { sessionId: 'backing1', kind: 'background' },
      { sessionId: 'turning1', kind: 'turn' },
    ]);
    expect(waiting).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(QUIT_TOOL_WAIT_LIMIT_MS);
    await expect(pending).resolves.toBe('timeout');
    const log = readFileSync(path.join(dataDir(), AGENT_WORKER_EXIT_LOG), 'utf8');
    expect(log).toContain('session-=工具在跑(bash)');
    expect(log).toContain('child-99(子会话)=工具在跑(bash)');
    expect(log).toContain('opening-=正在打开会话');
    expect(log).toContain('replying=回复在写');
    expect(log).toContain('backing1=转后台命令在跑(task-9)');
    expect(log).toContain('turning1=回合收尾中');
    warn.mockRestore();
  });

  it('只有正在打开的会话：告诉弹层在等命令，不当成在等回复', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = bootWithSession();
    const waiting = vi.fn();
    const pending = prepareAgentWorkerForQuit({
      reason: 'quit',
      hasRunningSessions: () => true,
      onWaitingForTools: waiting,
    });
    fork.children[index].emit('message', {
      type: 'graceful-restart-deferred',
      sessions: [{ identity, reason: 'session-starting', toolsInFlight: [] }],
    });
    expect(waiting).toHaveBeenCalledExactlyOnceWith('tool', [
      { sessionId: identity.sessionId, kind: 'starting' },
    ]);
    expect(forceAgentWorkerQuit()).toBe(true);
    return pending.finally(() => warn.mockRestore());
  });

  /** 起一次退出，worker 报告回复在写；返回推进时间并按需报告新 token 的工具 */
  function startReplyWait(reason: 'update' | 'quit' = 'update') {
    const index = bootWithSession();
    const t0 = Date.now();
    const state = { done: false };
    const pending = prepareAgentWorkerForQuit({ reason, hasRunningSessions: () => true });
    void pending.then(() => {
      state.done = true;
    });
    const reply = { requestStartMs: t0 - 5_000, firstTokenMs: t0 - 3_000 };
    const output = () =>
      fork.children[index].emit('message', writing({ ...reply, lastOutputMs: Date.now() }));
    /** 每 stepMs 出一次 token，持续 totalMs */
    const streamFor = async (totalMs: number, stepMs = 5_000) => {
      for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
        await vi.advanceTimersByTimeAsync(stepMs);
        output();
      }
    };
    const exitLog = () => readFileSync(path.join(dataDir(), AGENT_WORKER_EXIT_LOG), 'utf8');
    output();
    return { index, t0, state, pending, output, streamFor, exitLog };
  }

  it('保底 60 秒后仍在出 token 就接着等；停止输出超过 20 秒才中止，日志记下这次请求的时间线与结果', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = startReplyWait();
    await run.streamFor(100_000);
    expect(run.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(QUIT_REPLY_IDLE_MS - 1);
    expect(run.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(run.pending).resolves.toBe('timeout');
    const log = run.exitLog();
    expect(log).toContain(`停止出 token 超过 ${QUIT_REPLY_IDLE_MS}ms`);
    expect(log).toContain(
      `会话 session- 回复：请求发出 ${new Date(run.t0 - 5_000).toISOString()}，首 token +2.0s，最后出字 +105.0s，等了 120.0s，结果：空闲中止`
    );
    warn.mockRestore();
  });

  it('一直在出 token：等到回复等待上限 180 秒就中止', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = startReplyWait();
    await run.streamFor(QUIT_REPLY_WAIT_CAP_MS - 5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(run.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(run.pending).resolves.toBe('timeout');
    const log = run.exitLog();
    expect(log).toContain(`回复等待上限 ${QUIT_REPLY_WAIT_CAP_MS}ms`);
    expect(log).toContain('等了 180.0s，结果：总上限中止');
    warn.mockRestore();
  });

  it('保底内写完：不中止，到安全点放行并记成写完', async () => {
    vi.useFakeTimers();
    const run = startReplyWait();
    await run.streamFor(30_000);
    // 回复写完、回合结束：worker 不再报告这个会话在写，随后落断点
    fork.children[run.index].emit('message', deferred([], 'turn-in-progress'));
    await vi.advanceTimersByTimeAsync(2_000);
    fork.children[run.index].emit('message', { type: 'graceful-restart-ready', checkpoint });
    await expect(run.pending).resolves.toBe('checkpointed');
    expect(run.exitLog()).toContain('等了 30.0s，结果：写完');
  });

  it('保底后写完、回合还在收口：不因为不再出 token 立刻超时，等到安全点放行', async () => {
    vi.useFakeTimers();
    const run = startReplyWait();
    await run.streamFor(100_000);
    fork.children[run.index].emit('message', deferred([], 'turn-in-progress'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.state.done).toBe(false);
    fork.children[run.index].emit('message', { type: 'graceful-restart-ready', checkpoint });
    await expect(run.pending).resolves.toBe('checkpointed');
    expect(run.exitLog()).toContain('等了 100.0s，结果：写完');
  });

  it('工具跑了很久之后回复在写：仍受等安全点的总上限约束', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = bootWithSession();
    const pending = prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: () => true });
    fork.children[index].emit('message', deferred(['call-1']));
    await vi.advanceTimersByTimeAsync(QUIT_TOOL_WAIT_LIMIT_MS - 30_000);
    const t = Date.now();
    fork.children[index].emit('message', writing({ requestStartMs: t, lastOutputMs: t }));
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
      fork.children[index].emit(
        'message',
        writing({ requestStartMs: t, firstTokenMs: t + 1, lastOutputMs: Date.now() })
      );
    }
    await vi.advanceTimersByTimeAsync(4_999);
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('timeout');
    expect(readFileSync(path.join(dataDir(), AGENT_WORKER_EXIT_LOG), 'utf8')).toContain(
      `总上限 ${QUIT_TOOL_WAIT_LIMIT_MS}ms`
    );
    warn.mockRestore();
  });

  it('等回复时点强制退出：这次请求记成强制退出', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = startReplyWait('quit');
    await run.streamFor(10_000);
    expect(forceAgentWorkerQuit()).toBe(true);
    await expect(run.pending).resolves.toBe('timeout');
    expect(run.exitLog()).toContain('等了 10.0s，结果：强制退出');
    warn.mockRestore();
  });

  /** 等工具超过上限超时；stopAgentWorkerForQuit 终止 worker 时由 onKill 模拟它收尾落的断点 */
  async function timeOutOnLongTool(onKill?: () => void) {
    const index = bootWithSession();
    const pending = prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: () => true });
    fork.children[index].emit('message', deferred(['call-1']));
    await vi.advanceTimersByTimeAsync(QUIT_TOOL_WAIT_LIMIT_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('timeout');
    expect(() => readFileSync(manifestFile())).toThrow();
    vi.mocked(killAndWaitExit).mockImplementationOnce(async (child) => {
      child.kill();
      onKill?.();
    });
    await stopAgentWorkerForQuit(100);
    fork.children[index].emit('exit', 0);
    expect(fork.children).toHaveLength(index + 1);
    return readFileSync(path.join(dataDir(), AGENT_WORKER_EXIT_LOG), 'utf8');
  }
  const writeCheckpoint = (value: RestartCheckpoint) =>
    writeFileSync(path.join(dataDir(), RESTART_CHECKPOINT_FILE), JSON.stringify(value));

  it('工具跑超过上限：超时退出，worker 收尾时落的断点照样写成清单，冷启动据此续跑', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 真机：中止命令后 worker 停在下一次模型请求前，nextStep=model-request、toolsInFlight 为空
    const log = await timeOutOnLongTool(() =>
      writeCheckpoint({ ...checkpoint, writtenAt: Date.now() })
    );
    expect(log).toContain(`工具跑了超过上限 ${QUIT_TOOL_WAIT_LIMIT_MS}ms`);
    expect(log).toContain('写了恢复清单（1 个会话）');

    const raw = readFileSync(manifestFile(), 'utf8');
    expect(findSecretLikeStrings(raw, [API_KEY, OAUTH_TOKEN])).toEqual([]);
    expect(JSON.parse(raw)).toMatchObject({
      reason: 'quit',
      sessions: [
        {
          sessionId: identity.sessionId,
          nextStep: 'model-request',
          settings: { providerId: 'p', modelId: 'm', thinkingLevel: 'high', planMode: true },
        },
      ],
    });
    const plan = loadColdRestartPlan(dataDir());
    expect(plan?.resume.map((entry) => entry.sessionId)).toEqual([identity.sessionId]);
    stopAgentWorker();
    startAgentWorker({ restartCheckpointFile: plan?.checkpointFile });
    expect(fork.envs.at(-1)?.[RESTART_CHECKPOINT_ENV]).toBe(
      path.join(dataDir(), RESTART_CHECKPOINT_FILE)
    );
    const resumed: string[] = [];
    await resumeColdRestartSessions(plan!, async (entry) => {
      resumed.push(entry.sessionId);
      return { ok: true };
    });
    expect(resumed).toEqual([identity.sessionId]);
    warn.mockRestore();
  });

  it('写进恢复清单的会话算「重启后接着跑」：worker 退出事件发出时就已知道，清单外的不算', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = bootWithSession();
    const pending = prepareAgentWorkerForQuit({ reason: 'update', hasRunningSessions: () => true });
    fork.children[index].emit('message', deferred(['call-1']));
    await vi.advanceTimersByTimeAsync(QUIT_TOOL_WAIT_LIMIT_MS);
    await expect(pending).resolves.toBe('timeout');
    const atExit: Array<[boolean, boolean]> = [];
    setAgentEventListener((event) => {
      if (event.type === 'worker-exited')
        atExit.push([resumesAfterQuit(identity.sessionId), resumesAfterQuit('other')]);
    });
    // 真机顺序：worker 收尾落断点后退出，exit 先于 killAndWaitExit 返回
    vi.mocked(killAndWaitExit).mockImplementationOnce(async (child) => {
      child.kill();
      writeCheckpoint({ ...checkpoint, writtenAt: Date.now() });
      fork.children[index].emit('exit', 0);
    });
    await stopAgentWorkerForQuit(100);
    setAgentEventListener(() => {});
    expect(atExit).toEqual([[true, false]]);
    expect(JSON.parse(readFileSync(manifestFile(), 'utf8')).sessions).toHaveLength(1);
    cancelAgentQuitCheckpoint();
    expect(resumesAfterQuit(identity.sessionId)).toBe(false);
    warn.mockRestore();
  });

  it('超时且 worker 到退出都没落断点：不写清单，日志写明原因', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = await timeOutOnLongTool();
    expect(() => readFileSync(manifestFile())).toThrow();
    expect(log).toContain('不写恢复清单：worker 退出前没落断点（没到安全点）');
    warn.mockRestore();
  });

  it('强制退出：不等命令立刻放行，worker 收尾时落的断点照样写成清单', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = bootWithSession();
    expect(forceAgentWorkerQuit()).toBe(false);
    const pending = prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: () => true });
    // 转后台的命令还在跑：worker 报告它在途
    fork.children[index].emit('message', deferred(['task-1-abc']));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(forceAgentWorkerQuit()).toBe(true);
    await expect(pending).resolves.toBe('timeout');
    expect(forceAgentWorkerQuit()).toBe(false);

    vi.mocked(killAndWaitExit).mockImplementationOnce(async (child) => {
      child.kill();
      writeCheckpoint({ ...checkpoint, writtenAt: Date.now() });
    });
    await stopAgentWorkerForQuit(100);
    const log = readFileSync(path.join(dataDir(), AGENT_WORKER_EXIT_LOG), 'utf8');
    expect(log).toContain('用户强制退出');
    expect(log).toContain('写了恢复清单（1 个会话）');
    expect(JSON.parse(readFileSync(manifestFile(), 'utf8')).sessions).toHaveLength(1);
    warn.mockRestore();
  });

  it('强制退出且断点落不了：记日志照常退，不卡住', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = bootWithSession();
    const pending = prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: () => true });
    fork.children[index].emit('message', deferred(['task-1-abc']));
    expect(forceAgentWorkerQuit()).toBe(true);
    await expect(pending).resolves.toBe('timeout');
    await stopAgentWorkerForQuit(100);
    expect(() => readFileSync(manifestFile())).toThrow();
    expect(readFileSync(path.join(dataDir(), AGENT_WORKER_EXIT_LOG), 'utf8')).toContain(
      '不写恢复清单：worker 退出前没落断点'
    );
    warn.mockRestore();
  });

  it('超时且断点里还有工具在跑：不写清单，日志写明原因', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const busy = {
      ...checkpoint,
      writtenAt: Date.now(),
      sessions: [{ ...checkpoint.sessions[0], toolsInFlight: ['call-2'] }],
    };
    const log = await timeOutOnLongTool(() => writeCheckpoint(busy));
    expect(() => readFileSync(manifestFile())).toThrow();
    expect(log).toContain('不写恢复清单：断点里还有工具在跑');
    warn.mockRestore();
  });

  it('超时且磁盘上只有这次退出之前的旧断点：不写清单', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeCheckpoint(checkpoint);
    const log = await timeOutOnLongTool();
    expect(() => readFileSync(manifestFile())).toThrow();
    expect(log).toContain('不写恢复清单：断点是这次退出之前留下的');
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

describe('退出重启保留转后台命令', () => {
  const posted = (worker: number, type: string) =>
    fork.posted.filter(
      (entry) => entry.worker === worker && (entry.message as { type: string }).type === type
    );

  it('会话都空闲（不等安全点）：终止 worker 前先让它交出后台命令，收到回执才终止', async () => {
    const index = bootWithSession();
    await expect(
      prepareAgentWorkerForQuit({
        reason: 'quit',
        hasRunningSessions: () => false,
        keepBackgroundTasks: true,
      })
    ).resolves.toBe('skipped');
    const stopping = stopAgentWorkerForQuit(100);
    await Promise.resolve();
    expect(posted(index, 'detach-background-tasks')).toHaveLength(1);
    expect(fork.children[index].killed).toBe(0);
    fork.children[index].emit('message', { type: 'background-tasks-detached', detached: 1 });
    await stopping;
    expect(fork.children[index].killed).toBe(1);
  });

  it('等安全点的请求带上保留标记；在等的是脱离不了的转后台命令时告诉弹层', async () => {
    const index = bootWithSession();
    const waiting = vi.fn();
    const pending = prepareAgentWorkerForQuit({
      reason: 'quit',
      hasRunningSessions: () => true,
      onWaitingForTools: waiting,
      keepBackgroundTasks: true,
    });
    expect(graceful(index).map((entry) => entry.message)).toEqual([
      { type: 'graceful-restart', keepBackgroundTasks: true },
    ]);
    fork.children[index].emit('message', deferred(['call-1']));
    expect(waiting).toHaveBeenLastCalledWith('tool', [
      { sessionId: identity.sessionId, kind: 'background' },
    ]);
    fork.children[index].emit('message', {
      type: 'graceful-restart-deferred',
      sessions: [
        {
          identity,
          reason: 'tool-in-flight',
          toolsInFlight: ['task-1-abc'],
          undetachableTasks: ['task-1-abc'],
        },
      ],
    });
    expect(waiting).toHaveBeenLastCalledWith('background-not-detachable', [
      { sessionId: identity.sessionId, kind: 'background' },
    ]);
    expect(waiting).toHaveBeenCalledTimes(2);
    fork.children[index].emit('message', { type: 'graceful-restart-ready', checkpoint });
    await expect(pending).resolves.toBe('checkpointed');
  });

  it('worker 不回执：最多等一小段照常终止；普通退出不发交出请求', async () => {
    vi.useFakeTimers();
    const index = bootWithSession();
    await prepareAgentWorkerForQuit({
      reason: 'quit',
      hasRunningSessions: () => false,
      keepBackgroundTasks: true,
    });
    const stopping = stopAgentWorkerForQuit(100);
    await vi.advanceTimersByTimeAsync(DETACH_ACK_TIMEOUT_MS);
    await stopping;
    expect(fork.children[index].killed).toBe(1);
    expect(readFileSync(path.join(dataDir(), AGENT_WORKER_EXIT_LOG), 'utf8')).toContain('没在');

    stopAgentWorker();
    const next = bootWithSession();
    await prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: () => false });
    await stopAgentWorkerForQuit(100);
    expect(posted(next, 'detach-background-tasks')).toHaveLength(0);
    expect(fork.children[next].killed).toBe(1);
  });
});
