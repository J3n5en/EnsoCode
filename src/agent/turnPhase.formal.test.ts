import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { afterAll, describe, expect, it, vi } from 'vitest';

// 有界穷举 worker 轮次相位：真实 SessionSupervisor 对接一个 pi AgentSession 模型，
// 客户端命令、pi 的每一步、计时器到点按任意顺序交错。属性与范围见 .agents/skills/formal-turn-phase/SKILL.md。

const mocks = vi.hoisted(() => ({ next: undefined as undefined | (() => unknown) }));

vi.mock('./cursor/loadProvider', () => ({
  CURSOR_PROVIDER_ID: 'cursor',
  loadCursorProvider: vi.fn(async () => undefined),
}));

vi.mock('./mcp', () => ({
  McpManager: class {
    toolsFor = vi.fn(async () => []);
    closeAll = vi.fn(async () => undefined);
  },
}));

// 每次回放都会对 cwd 起一次 git 子进程清旧快照，与轮次相位无关
vi.mock('./checkpoint/manager', async (importOriginal) => {
  const original = await importOriginal<typeof import('./checkpoint/manager')>();
  class CheckpointManager extends original.CheckpointManager {
    override cleanupOldSessions(): void {}
  }
  return { ...original, CheckpointManager };
});

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  class Loader {
    async reload() {}
    getSkills() {
      return { skills: [] };
    }
    getPrompts() {
      return { prompts: [] };
    }
  }
  const manager = () => {
    const branch: unknown[] = [];
    return {
      getBranch: () => branch,
      appendCustomEntry: (customType: string, data: unknown) => {
        branch.push({ type: 'custom', customType, data });
        return `entry-${branch.length}`;
      },
      buildSessionContext: () => ({ messages: [] }),
    };
  };
  const runtime = {
    models: new Map<string, Record<string, unknown>>(),
    registerProvider(providerId: string, config: { models?: Record<string, unknown>[] }) {
      for (const model of config.models ?? []) {
        this.models.set(`${providerId}/${model.id}`, { ...model, provider: providerId });
      }
    },
    getModel(providerId: string, modelId: string) {
      return this.models.get(`${providerId}/${modelId}`);
    },
    getModels() {
      return [...this.models.values()];
    },
    resolveModel: async () => {
      throw new Error('unexpected virtual model');
    },
    getAuth: async () => undefined,
    getProvider(providerId: string) {
      if (![...this.models.keys()].some((key) => key.startsWith(`${providerId}/`)))
        return undefined;
      return { id: providerId, models: [], stream: () => undefined, streamSimple: () => undefined };
    },
    registerNativeProvider: () => undefined,
    refresh: async () => ({ aborted: false, errors: new Map() }),
    completeSimple: async () => ({ content: [] }),
  };
  return {
    ...original,
    DefaultResourceLoader: Loader,
    ModelRuntime: { create: async () => runtime },
    SessionManager: { create: manager, open: manager, inMemory: manager },
    createAgentSession: async (options: Record<string, unknown>) => ({
      session: Object.assign(mocks.next!() as object, {
        model: options.model,
        resourceLoader: options.resourceLoader,
        sessionManager: options.sessionManager,
      }),
    }),
  };
});

import { SessionSupervisor } from './supervisor';

const parent = { sessionId: 'parent', generation: '11111111-1111-4111-8111-111111111111' };
const model = {
  api: 'openai-completions' as const,
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  modelId: 'model',
  settingsProviderId: 'settings-provider',
};

/** supervisor.ts ZOMBIE_TURN_WAIT_MS */
const ZOMBIE_MS = 5_000;

interface Timer {
  id: number;
  due: number;
  label: string;
  fn: () => void;
  /** 僵尸时限：登记时 pi 已发出的事件数。supervisor 的 activityNonce 每个会话事件加一，stillLive 据此判活 */
  armedAt?: number;
}

/** 虚拟时钟：替换全局计时器，到点只由模型动作触发；同一到点时刻按登记先后 */
class Clock {
  now = 0;
  private seq = 0;
  timers = new Map<number, Timer>();
  piEvents = () => 0;
  private saved?: Pick<
    typeof globalThis,
    'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'
  >;

  add(fn: () => void, ms: number, label?: string): { id: number } {
    const id = ++this.seq;
    const timer: Timer = {
      id,
      due: this.now + ms,
      fn,
      label: label ?? (ms === ZOMBIE_MS ? '僵尸时限' : ms === 0 ? '让一拍' : `${ms}ms`),
    };
    if (ms === ZOMBIE_MS) timer.armedAt = this.piEvents();
    this.timers.set(id, timer);
    const handle = { id, unref: () => handle, ref: () => handle, hasRef: () => false };
    return handle;
  }

  install(): void {
    this.saved = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    };
    Object.assign(globalThis, {
      setTimeout: (fn: () => void, ms = 0) => this.add(fn, ms),
      clearTimeout: (handle?: { id?: number }) => {
        if (handle?.id !== undefined) this.timers.delete(handle.id);
      },
      // 闲置回收等周期任务不在模型内，登记后永不触发
      setInterval: () => ({ id: -1, unref() {}, ref() {}, hasRef: () => false }),
      clearInterval: () => undefined,
    });
  }

  restore(): void {
    if (this.saved) Object.assign(globalThis, this.saved);
  }

  reset(): void {
    this.now = 0;
    this.timers.clear();
  }

  next(): Timer | undefined {
    let best: Timer | undefined;
    for (const t of this.timers.values()) {
      if (!best || t.due < best.due || (t.due === best.due && t.id < best.id)) best = t;
    }
    return best;
  }

  fire(): void {
    const t = this.next()!;
    this.timers.delete(t.id);
    this.now = Math.max(this.now, t.due);
    t.fn();
  }

  view(): string[] {
    return [...this.timers.values()]
      .sort((a, b) => a.due - b.due || a.id - b.id)
      .map((t) => {
        const live = t.armedAt === undefined ? '' : this.piEvents() > t.armedAt ? '+' : '-';
        return `${t.label}@${t.due - this.now}${live}`;
      });
  }
}

// ---------- pi AgentSession 模型：@earendil-works/pi-coding-agent dist/core/agent-session.js ----------

type Phase =
  /** _isAgentRunActive=false */
  | 'idle'
  /** _startRun 已置 _isAgentRunActive，_prepareRun 中（agent_start 之前） */
  | 'preparing'
  /** agent loop 中：agent_start 之后、agent_end 之前 */
  | 'looping'
  /** _prepareRetry 的退避 sleep（isRetrying） */
  | 'retryWait'
  /** _checkCompaction → _runAutoCompaction('overflow') */
  | 'compacting'
  /** _emitAgentSettled 进行中（_isEmittingAgentSettled）：只在同步回调里可见 */
  | 'settling';
type Reply = 'none' | 'ok' | 'error' | 'overflow' | 'aborted';
type PiEvent = Record<string, unknown> & { type: string };

/** 每次探索里 pi 可用的意外次数 */
interface Budget {
  /** 可重试错误（503） */
  errors: number;
  /** 上下文溢出 → 自动压缩续跑 */
  overflows: number;
  /** continuousMemory compaction-trigger：agent_settled 后 setTimeout(0) 起手动压缩 */
  memCompactions: number;
  /** agent_before_settle 扩展要求续跑 */
  beforeSettle: number;
}

/** settingsManager.getRetrySettings().maxRetries */
const MAX_RETRIES = 1;
/** pi 预检拒收（没有 key、input hook 抛错）的错误文案：prompt 抛错且从未回调 preflightResult */
const PREFLIGHT_ERROR = 'No API key';

class Pi {
  phase: Phase = 'idle';
  /** _startRun 次数；第 n 次运行即第 n 个轮次 */
  run = 0;
  /** _agentRunAbortRequested */
  aborting = false;
  /** agent.followUpQueue */
  followUps: string[] = [];
  starting?: { text: string; started?: () => void };
  reply: Reply = 'none';
  /** _retryAttempt */
  retryAttempt = 0;
  /** 本次退避被 abortRetry 取消（_prepareRetry 已返回 false） */
  retryCancelled = false;
  /** _overflowRecoveryAttempted */
  overflowTried = false;
  /** _compactionAbortController（手动压缩）；scheduled = 扩展的 setTimeout(0) 未到点 */
  mem: 'none' | 'scheduled' | 'running' = 'none';
  /** _deferredSettledActions */
  deferred: (() => void)[] = [];
  runDone?: () => void;
  idleWaiters: (() => void)[] = [];
  delivered: string[] = [];
  /** 这些 prompt 会被预检拒收；rejected 是真的走到预检被拒的，按发生顺序 */
  rejects = new Set<string>();
  rejected: string[] = [];
  messages: Record<string, unknown>[] = [];
  events = 0;
  listeners = new Set<(event: PiEvent) => void>();
  onEvent: (event: PiEvent) => void = () => {};

  constructor(
    readonly clock: Clock,
    readonly budget: Budget
  ) {}

  /** isStreaming = _isAgentRunActive */
  get isStreaming(): boolean {
    return this.phase !== 'idle' && this.phase !== 'settling';
  }
  get isCompacting(): boolean {
    return this.phase === 'compacting' || this.mem === 'running';
  }
  /** _retryAbortController !== undefined */
  get isRetrying(): boolean {
    return this.phase === 'retryWait' && !this.retryCancelled;
  }
  get isIdle(): boolean {
    return !this.isStreaming && !this.isCompacting;
  }

  emit(event: PiEvent): void {
    this.events++;
    this.onEvent(event);
    for (const listener of [...this.listeners]) listener(event);
  }

  subscribe = (listener: (event: PiEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  waitForIdle = (): Promise<void> => {
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  };

  /** _resolveIdleWaitIfIdle */
  private resolveIdle(): void {
    if (!this.isIdle) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  /** prompt() → _preparePrompt()（流式中排 followUp）→ _startRun() */
  prompt = async (
    text: string,
    options?: { streamingBehavior?: string; preflightResult?: (disposition: string) => void }
  ): Promise<void> => {
    if (this.rejects.has(text)) {
      this.rejected.push(text);
      throw new Error(PREFLIGHT_ERROR);
    }
    if (this.phase === 'settling') {
      this.deferred.push(() => void this.prompt(text, options).catch(() => {}));
      return;
    }
    if (this.mem === 'running') {
      throw new Error(
        'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.'
      );
    }
    if (this.isStreaming) {
      if (!options?.streamingBehavior) {
        throw new Error(
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
        );
      }
      this.followUps.push(text);
      options?.preflightResult?.('queued');
      return;
    }
    this.phase = 'preparing';
    this.run++;
    this.aborting = false;
    this.reply = 'none';
    this.starting = { text, started: () => options?.preflightResult?.('started') };
    await new Promise<void>((resolve) => {
      this.runDone = resolve;
    });
  };

  /** abort()：只在运行活跃时记 _agentRunAbortRequested；取消退避与压缩；不清 followUp 队列 */
  abort = async (): Promise<void> => {
    if (this.isStreaming) this.aborting = true;
    this.abortRetry();
    if (this.mem === 'running') queueMicrotask(() => this.endMemCompaction(true));
    await this.waitForIdle();
  };

  /** abortRetry()：退避 sleep 抛出，_prepareRetry 的 catch 经 _finishCancelledRetry 发 auto_retry_end(false) */
  abortRetry = (): void => {
    if (!this.isRetrying) return;
    this.retryCancelled = true;
    queueMicrotask(() => {
      const attempt = this.retryAttempt;
      this.retryAttempt = 0;
      this.emit({ type: 'auto_retry_end', success: false, attempt, finalError: 'Retry cancelled' });
      this.post(false);
    });
  };

  private pushUser(text: string): void {
    const message = { role: 'user', content: [{ type: 'text', text }], timestamp: 0 };
    this.delivered.push(text);
    this.messages.push(message);
    this.emit({ type: 'message_start', message });
    this.emit({ type: 'message_end', message });
  }

  /** _handleAgentEvent 的 message_end：成功回复重置重试计数并发 auto_retry_end(true) */
  private pushAssistant(reply: Exclude<Reply, 'none'>): void {
    const message =
      reply === 'ok'
        ? { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' }
        : reply === 'aborted'
          ? { role: 'assistant', content: [], stopReason: 'aborted' }
          : {
              role: 'assistant',
              content: [],
              stopReason: 'error',
              errorMessage:
                reply === 'error'
                  ? '503 Service Unavailable'
                  : 'prompt is too long: context overflow',
            };
    this.messages.push(message);
    this.reply = reply;
    this.emit({ type: 'message_start', message });
    this.emit({ type: 'message_end', message });
    if (reply === 'ok') {
      this.overflowTried = false;
      if (this.retryAttempt > 0) {
        const attempt = this.retryAttempt;
        this.retryAttempt = 0;
        this.emit({ type: 'auto_retry_end', success: true, attempt });
      }
    }
  }

  private agentStart(): void {
    this.phase = 'looping';
    this.reply = 'none';
    this.emit({ type: 'agent_start' });
  }

  /**
   * agent loop 发 agent_end（willRetry = _willRetryAfterAgentEnd），随后 _startRun 循环里的
   * _handlePostAgentRun / _runBeforeSettleBoundary / _emitAgentSettled 之间只有微任务，作为一步。
   */
  private endRun(beforeSettle = false): void {
    const willRetry = !this.aborting && this.reply === 'error' && this.retryAttempt < MAX_RETRIES;
    this.retryCancelled = false;
    this.emit({ type: 'agent_end', messages: [], willRetry });
    this.post(beforeSettle);
  }

  private dropLastAssistant(): void {
    if (this.messages.at(-1)?.role === 'assistant') this.messages.pop();
  }

  private endMemCompaction(aborted: boolean): void {
    if (this.mem !== 'running') return;
    this.mem = 'none';
    this.emit({ type: 'compaction_end', reason: 'manual', aborted, willRetry: false });
    this.resolveIdle();
  }

  /** 当前可走的 pi 步骤：标签 → 执行 */
  actions(): [string, () => void][] {
    const out: [string, () => void][] = [];
    switch (this.phase) {
      case 'preparing':
        out.push([
          'pi 开始 agent loop',
          () => {
            const starting = this.starting!;
            this.starting = undefined;
            starting.started?.();
            this.agentStart();
            this.pushUser(starting.text);
          },
        ]);
        break;
      case 'looping':
        // pi-agent-core agent-loop：回复 error / aborted 直接 agent_end，不取排队消息
        if (this.aborting) {
          out.push([
            'pi 响应中断，收尾',
            () => {
              if (this.reply === 'none') this.pushAssistant('aborted');
              this.endRun();
            },
          ]);
        } else if (this.reply === 'none') {
          out.push(['pi 回复成功', () => this.pushAssistant('ok')]);
          if (this.budget.errors > 0) {
            out.push([
              'pi 回复 503，收尾',
              () => {
                this.budget.errors--;
                this.pushAssistant('error');
                this.endRun();
              },
            ]);
          }
          if (this.budget.overflows > 0 && !this.overflowTried) {
            out.push([
              'pi 回复上下文溢出，收尾',
              () => {
                this.budget.overflows--;
                this.pushAssistant('overflow');
                this.endRun();
              },
            ]);
          }
        } else if (this.followUps.length > 0) {
          out.push([
            `pi 取出排队消息 ${this.followUps[0]}`,
            () => {
              this.pushUser(this.followUps.shift()!);
              this.reply = 'none';
            },
          ]);
        } else {
          out.push(['pi agent_end，收尾', () => this.endRun()]);
          if (this.budget.beforeSettle > 0) {
            out.push(['pi agent_end，agent_before_settle 要求续跑', () => this.endRun(true)]);
          }
        }
        break;
      case 'retryWait':
        if (!this.retryCancelled) out.push(['pi 重试退避结束，续跑', () => this.agentStart()]);
        break;
      case 'compacting':
        out.push([
          this.aborting ? 'pi 溢出压缩被中断，收尾' : 'pi 溢出压缩完成，续跑',
          () => {
            const aborted = this.aborting;
            this.emit({ type: 'compaction_end', reason: 'overflow', aborted, willRetry: !aborted });
            if (aborted) this.post(false);
            else this.agentStart();
          },
        ]);
        break;
      case 'idle':
      case 'settling':
        break;
    }
    if (this.mem === 'running') {
      out.push(['pi 记忆压缩完成', () => this.endMemCompaction(false)]);
    }
    return out;
  }

  /** _handlePostAgentRun + _runBeforeSettleBoundary 的判定，不续跑就 _emitAgentSettled */
  private post(beforeSettle: boolean): void {
    if (this.aborting) {
      this.settle();
      return;
    }
    if (this.reply === 'error' && !this.retryCancelled && this.retryAttempt < MAX_RETRIES) {
      this.retryAttempt++;
      this.emit({
        type: 'auto_retry_start',
        attempt: this.retryAttempt,
        maxAttempts: MAX_RETRIES,
        delayMs: 1000,
        errorMessage: '503 Service Unavailable',
      });
      this.dropLastAssistant();
      this.phase = 'retryWait';
      return;
    }
    if (this.reply === 'error' && this.retryAttempt > 0) {
      const attempt = this.retryAttempt;
      this.retryAttempt = 0;
      this.emit({
        type: 'auto_retry_end',
        success: false,
        attempt,
        finalError: '503 Service Unavailable',
      });
    }
    this.retryCancelled = false;
    if (this.reply === 'overflow' && !this.overflowTried) {
      this.overflowTried = true;
      this.dropLastAssistant();
      this.phase = 'compacting';
      this.emit({ type: 'compaction_start', reason: 'overflow' });
      return;
    }
    if (this.followUps.length > 0 || beforeSettle) {
      if (this.followUps.length === 0) this.budget.beforeSettle--;
      this.agentStart();
      return;
    }
    this.settle();
  }

  /**
   * _emitAgentSettled：清 _isAgentRunActive；扩展先收 agent_settled（记忆压缩在此排 setTimeout(0)），
   * 再公开 agent_settled，再执行收束期间延后的 prompt，最后唤醒空闲等待者。agent_settled 的扩展回调都是同步的，整段是一步。
   */
  private settle(): void {
    this.phase = 'settling';
    if (this.budget.memCompactions > 0 && this.mem === 'none') {
      this.budget.memCompactions--;
      this.mem = 'scheduled';
      this.clock.add(
        () => {
          // compaction-trigger.ts：到点时不空闲就放弃
          if (!this.isIdle) {
            this.mem = 'none';
            return;
          }
          this.mem = 'running';
          this.emit({ type: 'compaction_start', reason: 'manual' });
        },
        0,
        '记忆压缩触发'
      );
    }
    const aborted = this.aborting;
    this.emit({ type: 'agent_settled', aborted });
    this.phase = 'idle';
    this.aborting = false;
    this.reply = 'none';
    const done = this.runDone;
    this.runDone = undefined;
    for (const action of this.deferred.splice(0)) action();
    done?.();
    this.resolveIdle();
  }

  view(): unknown {
    return [
      this.phase,
      this.aborting,
      this.followUps,
      this.starting?.text,
      this.reply,
      this.retryAttempt,
      this.retryCancelled,
      this.overflowTried,
      this.mem,
      this.deferred.length,
      this.runDone !== undefined,
      this.delivered,
      this.rejected,
      this.messages.map((m) => `${m.role}:${m.stopReason ?? ''}`),
      this.budget,
    ];
  }
}

// ---------- 世界：真实 SessionSupervisor + pi 模型 + 客户端 ----------

interface Config {
  prompts: number;
  aborts: number;
  abortRetries: number;
  budget: Budget;
  /** 客户端在 running 时也发 prompt（bots / 定时任务 / 跨窗口竞态）；false 时像桌面 renderer 只在非 running 时发 */
  sendWhileRunning: boolean;
  /** 僵尸时限可先于 pi 的下一步到点（工具不响应中断）；false 时 pi 总在 5 秒内推进 */
  zombie: boolean;
  /** 客户端可发几条会被 pi 预检拒收的 prompt */
  rejects?: number;
}

interface Run {
  terminals: string[];
  aborted: boolean;
}

interface World {
  sup: SessionSupervisor;
  pi: Pi;
  client: { sent: number; aborts: number; abortRetries: number; status: string; retry: boolean };
  runs: Run[];
  /** delivery-rejected 的 deliveryId，按到达顺序 */
  receipts: string[];
  /** 预检拒收的 prompt 序号，按发出顺序；failed 是已收到失败终态的 */
  preflight: { sent: number[]; failed: number[] };
  /** p1..p<stoppable> 发出之后有过叫停（中断、取消重试、新 prompt 打断重试、僵尸时限到点），可以收未送达回执 */
  stoppable: number;
  broken: string | null;
  ready: boolean;
}

const clock = new Clock();
const tempRoot = mkdtempSync(path.join(tmpdir(), 'enso-formal-turn-'));
const sessionDir = path.join(tempRoot, 'sessions');
const agentDir = path.join(tempRoot, 'agent');
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

/** 计时器已虚拟化，一个宏任务足以跑完一步触发的全部微任务链；回放时的状态比对会抓住漏网的异步 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function piSession(pi: Pi): unknown {
  return Object.defineProperties(
    {
      sessionFile: path.join(tempRoot, 'turn.jsonl'),
      agent: {
        state: { messages: pi.messages },
        continue: async () => {},
        abort: () => {},
        clearFollowUpQueue: () => void pi.followUps.splice(0),
      },
      subscribe: pi.subscribe,
      prompt: pi.prompt,
      getFollowUpMessages: () => pi.followUps,
      _emitQueueUpdate: () => {},
      steer: async () => {},
      abort: pi.abort,
      abortRetry: pi.abortRetry,
      waitForIdle: pi.waitForIdle,
      compact: async () => {},
      dispose: () => {},
      setThinkingLevel: () => {},
      getActiveToolNames: () => [],
      setActiveToolsByName: () => {},
      navigateTree: async () => ({ cancelled: false }),
      settingsManager: {
        getRetrySettings: () => ({ enabled: true, maxRetries: MAX_RETRIES, baseDelayMs: 1000 }),
        getRetryEnabled: () => true,
      },
    },
    {
      messages: { get: () => pi.messages },
      isStreaming: { get: () => pi.isStreaming },
      isCompacting: { get: () => pi.isCompacting },
      isRetrying: { get: () => pi.isRetrying },
      isIdle: { get: () => pi.isIdle },
    }
  );
}

async function boot(cfg: Config): Promise<World> {
  clock.reset();
  const pi = new Pi(clock, { ...cfg.budget });
  clock.piEvents = () => pi.events;
  mocks.next = () => piSession(pi);
  const w: World = {
    sup: undefined as unknown as SessionSupervisor,
    pi,
    client: { sent: 0, aborts: 0, abortRetries: 0, status: 'idle', retry: false },
    runs: [],
    receipts: [],
    preflight: { sent: [], failed: [] },
    stoppable: 0,
    broken: null,
    ready: false,
  };
  pi.onEvent = (event) => observePi(w, event);
  w.sup = new SessionSupervisor({ emit: (event) => observeWorker(w, event), agentDir, sessionDir });
  w.sup.handleCommand({ type: 'spawn-parent', identity: parent, cwd: '/workspace', model });
  for (let i = 0; i < 10_000 && !w.ready; i++) await flush();
  if (!w.ready) throw new Error('spawn-parent 未就绪');
  return w;
}

function currentRun(w: World): Run | undefined {
  while (w.runs.length < w.pi.run) w.runs.push({ terminals: [], aborted: false });
  return w.runs[w.pi.run - 1];
}

function observePi(w: World, event: PiEvent): void {
  const run = currentRun(w);
  if (
    (event.type === 'agent_start' || event.type === 'auto_retry_start') &&
    run?.terminals.length
  ) {
    w.broken ??= `终态 ${run.terminals[0]} 之后 pi 仍为第 ${w.pi.run} 轮发出 ${event.type}`;
  }
}

function observeWorker(w: World, event: AgentWorkerEvent): void {
  if (event.type === 'parent-ready') w.ready = true;
  if (event.type === 'status') w.client.status = event.status;
  if (event.type === 'turn-retry') w.client.retry = true;
  if (event.type === 'delivery-rejected') {
    w.receipts.push(event.deliveryId);
    const n = Number(event.deliveryId.slice(1));
    if (!(n >= 1 && n <= w.client.sent)) {
      w.broken ??= `未知投递 ${event.deliveryId} 收到 delivery-rejected`;
    } else if (n > w.stoppable && !w.preflight.sent.includes(n)) {
      w.broken ??= `p${n} 没被叫停却收到 delivery-rejected`;
    } else if (w.receipts.filter((id) => id === event.deliveryId).length > 1) {
      w.broken ??= `p${n} 收到 2 次 delivery-rejected`;
    }
    return;
  }
  // 消费者（bots、headless、Main、renderer）按会话把任何 turn-* 当作本轮终态，不看 turnId
  if (event.type !== 'turn-completed' && event.type !== 'turn-failed') return;
  if (event.type === 'turn-failed' && event.error === PREFLIGHT_ERROR) {
    const n = w.pi.rejected
      .map((text) => Number(text.slice(1)))
      .find((i) => !w.preflight.failed.includes(i));
    if (n === undefined) {
      w.broken ??= '没有预检拒收的 prompt 却收到预检失败终态';
    } else if (w.receipts.includes(`d${n}`)) {
      w.broken ??= `p${n} 的拒收回执先于它的失败终态：收到回执就让出会话的消费者会把这个失败记到下一条投递头上`;
    }
    if (n !== undefined) w.preflight.failed.push(n);
    return;
  }
  w.client.retry = false;
  const label = `${event.type}${event.aborted ? '(aborted)' : ''}`;
  const run = currentRun(w);
  if (!run) {
    w.broken ??= `pi 还没开始任何一轮就收到 ${label}`;
    return;
  }
  run.terminals.push(label);
  if (run.terminals.length > 1) {
    w.broken ??= `第 ${w.pi.run} 轮收到 ${run.terminals.length} 个终态：${run.terminals.join('、')}`;
  }
}

function actions(w: World, cfg: Config): [string, () => void][] {
  const out: [string, () => void][] = [];
  const canSend =
    w.client.sent < cfg.prompts && (cfg.sendWhileRunning || w.client.status !== 'running');
  if (canSend && w.preflight.sent.length < (cfg.rejects ?? 0)) {
    const n = w.client.sent + 1;
    out.push([
      `客户端 prompt p${n}（预检拒收）`,
      () => {
        if (w.pi.isRetrying) w.stoppable = n - 1;
        w.client.sent = n;
        w.preflight.sent.push(n);
        w.pi.rejects.add(`p${n}`);
        w.sup.handleCommand({
          type: 'prompt',
          identity: parent,
          text: `p${n}`,
          deliveryId: `d${n}`,
        });
      },
    ]);
  }
  if (canSend) {
    const n = w.client.sent + 1;
    out.push([
      `客户端 prompt p${n}`,
      () => {
        // 新 prompt 经 interruptRetryIfAny 打断重试，等同叫停此前的 prompt
        if (w.pi.isRetrying) w.stoppable = n - 1;
        w.client.sent = n;
        w.sup.handleCommand({
          type: 'prompt',
          identity: parent,
          text: `p${n}`,
          deliveryId: `d${n}`,
        });
      },
    ]);
  }
  if (w.client.aborts < cfg.aborts && w.client.status === 'running') {
    out.push([
      '客户端 abort',
      () => {
        w.client.aborts++;
        w.stoppable = w.client.sent;
        const run = currentRun(w);
        if (run && w.pi.isStreaming) run.aborted = true;
        w.sup.handleCommand({ type: 'abort', identity: parent });
      },
    ]);
  }
  if (w.client.abortRetries < cfg.abortRetries && w.client.retry) {
    out.push([
      '客户端取消重试',
      () => {
        w.client.abortRetries++;
        w.stoppable = w.client.sent;
        w.sup.handleCommand({ type: 'abort-retry', identity: parent });
      },
    ]);
  }
  const piActions = w.pi.actions();
  out.push(...piActions);
  const timer = clock.next();
  if (timer && (cfg.zombie || timer.label !== '僵尸时限' || piActions.length === 0)) {
    out.push([
      `计时器到点：${timer.label}`,
      () => {
        if (timer.label === '僵尸时限') w.stoppable = w.client.sent;
        clock.fire();
      },
    ]);
  }
  return out;
}

function managedOf(sup: SessionSupervisor): Record<string, unknown> {
  return (sup as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions.get(
    parent.sessionId
  )!;
}

function key(w: World): string {
  const m = managedOf(w.sup);
  return JSON.stringify([
    w.pi.view(),
    clock.view(),
    w.client,
    w.runs,
    w.receipts,
    w.preflight,
    w.stoppable,
    m.status,
    m.settlePending,
    m.turnAborted,
    m.turnRetried,
    m.compaction,
    m.currentTurnId !== undefined,
    m.abortedTurnId !== undefined,
    (w.sup as unknown as { pendingCommands: Map<string, number> }).pendingCommands.get(
      parent.sessionId
    ),
  ]);
}

function safetyViolation(w: World): string | null {
  if (w.broken) return w.broken;
  const seen = new Set<string>();
  for (const text of w.pi.delivered) {
    if (seen.has(text)) return `${text} 进入 pi 两次`;
    if (w.receipts.includes(`d${text.slice(1)}`)) return `${text} 进了 pi 又收到 delivery-rejected`;
    seen.add(text);
  }
  return null;
}

/** 静止（没有任何可走的步骤）时必须成立 */
function quiescentViolation(w: World): string | null {
  for (const [i, run] of w.runs.entries()) {
    if (run.terminals.length === 0) return `第 ${i + 1} 轮没有终态`;
    if (run.aborted && !run.terminals[0]!.endsWith('(aborted)')) {
      return `第 ${i + 1} 轮被中断，终态却是 ${run.terminals[0]}`;
    }
  }
  if (w.client.status === 'running') return 'worker 停在 running';
  for (let i = 1; i <= w.client.sent; i++) {
    if (w.pi.delivered.includes(`p${i}`)) continue;
    const receipts = w.receipts.filter((id) => id === `d${i}`).length;
    if (receipts !== 1) return `p${i} 没进 pi，未送达回执 ${receipts} 次`;
  }
  return null;
}

async function step(w: World, cfg: Config, label: string): Promise<void> {
  const action = actions(w, cfg).find(([l]) => l === label);
  if (!action) throw new Error(`回放不确定：${label} 不可用`);
  action[1]();
  await flush();
}

interface Result {
  states: number;
  /** 违反类别 → 该类别的最短反例 */
  counterexamples: Map<string, string>;
}

/**
 * 深度优先展开：第一个后继直接在活着的世界上继续走，其余后继从头回放真实代码（闭包与 promise 无法克隆）。
 * 展开时记下整张状态图，最后在图上广度优先求每类违反的最短反例。
 */
async function explore(cfg: Config): Promise<Result> {
  const ids = new Map<string, number>();
  const edges: [string, number][][] = [];
  const bad = new Map<number, string>();
  clock.install();
  const quiet = (['log', 'info', 'warn', 'debug'] as const).map((k) =>
    vi.spyOn(console, k).mockImplementation(() => undefined)
  );
  try {
    let live = await boot(cfg);
    let liveTrace: string[] = [];
    ids.set(key(live), 0);
    edges.push([]);
    const stack = [{ id: 0, trace: liveTrace, labels: actions(live, cfg).map(([l]) => l), i: 0 }];
    while (stack.length > 0) {
      const top = stack.at(-1)!;
      if (top.i === top.labels.length) {
        stack.pop();
        continue;
      }
      const label = top.labels[top.i++]!;
      if (liveTrace !== top.trace) {
        live = await boot(cfg);
        for (const l of top.trace) await step(live, cfg, l);
        if (ids.get(key(live)) !== top.id) throw new Error(`回放不确定：${top.trace.join(' → ')}`);
      }
      await step(live, cfg, label);
      liveTrace = [...top.trace, label];
      const k = key(live);
      const known = ids.get(k);
      if (known !== undefined) {
        edges[top.id]!.push([label, known]);
        continue;
      }
      const id = edges.length;
      ids.set(k, id);
      edges.push([]);
      edges[top.id]!.push([label, id]);
      const enabled = actions(live, cfg).map(([l]) => l);
      const broken =
        safetyViolation(live) ?? (enabled.length === 0 ? quiescentViolation(live) : null);
      if (broken) bad.set(id, broken);
      else stack.push({ id, trace: liveTrace, labels: enabled, i: 0 });
    }
  } finally {
    for (const spy of quiet) spy.mockRestore();
    clock.restore();
  }
  const prev = new Map<number, [number, string]>([[0, [-1, '']]]);
  const order = [0];
  for (let i = 0; i < order.length; i++) {
    for (const [label, to] of edges[order[i]!]!) {
      if (prev.has(to)) continue;
      prev.set(to, [order[i]!, label]);
      order.push(to);
    }
  }
  const counterexamples = new Map<string, string>();
  for (const id of order) {
    const broken = bad.get(id);
    if (broken === undefined) continue;
    const kind = broken.replace(/p\d+|\d+/g, '#');
    if (counterexamples.has(kind)) continue;
    const trace: string[] = [];
    for (let at = id; at !== 0; at = prev.get(at)![0]) trace.unshift(prev.get(at)![1]);
    counterexamples.set(
      kind,
      [...trace.map((s, i) => `${i + 1}. ${s}`), `=> ${broken}`].join('\n')
    );
  }
  return { states: ids.size, counterexamples };
}

function report(result: Result): string {
  return [...result.counterexamples.values()].join('\n\n');
}

const FULL = process.env.ENSO_FORMAL_FULL === '1';
/**
 * 桌面 renderer 只在非 running 时发 prompt（running 时进本地队列）；其他发送方（bots、定时任务、
 * enso-server run、跨窗口竞态）随时可能发。僵尸时限先到点即 abort 后工具 5 秒内没停下。
 */
const core: { name: string; cfg: Config; min: number }[] = [
  {
    name: '桌面发送：中断、重试与重试耗尽、取消重试、记忆压缩',
    cfg: {
      prompts: FULL ? 3 : 2,
      aborts: 1,
      abortRetries: 1,
      budget: { errors: 2, overflows: FULL ? 1 : 0, memCompactions: 1, beforeSettle: FULL ? 1 : 0 },
      sendWhileRunning: false,
      zombie: false,
    },
    min: FULL ? 20_000 : 450,
  },
  ...(FULL
    ? [
        {
          name: '桌面发送：中断落在溢出压缩续跑、agent_before_settle 续跑上',
          cfg: {
            prompts: 2,
            aborts: 1,
            abortRetries: 0,
            budget: { errors: 0, overflows: 1, memCompactions: 1, beforeSettle: 1 },
            sendWhileRunning: false,
            zombie: false,
          },
          min: 400,
        },
      ]
    : []),
  {
    name: '随时发送：排队消息遇上中断、重试与取消重试、溢出压缩续跑与 agent_before_settle 续跑',
    cfg: {
      prompts: 2,
      aborts: 1,
      abortRetries: 1,
      budget: { errors: FULL ? 2 : 1, overflows: 1, memCompactions: 1, beforeSettle: 1 },
      sendWhileRunning: true,
      zombie: false,
    },
    min: FULL ? 600 : 450,
  },
  {
    name: '僵尸时限：工具不响应中断时排队 prompt 限时回执、活轮不误判',
    cfg: {
      prompts: FULL ? 3 : 2,
      aborts: 1,
      abortRetries: 1,
      budget: {
        errors: 1,
        overflows: 1,
        memCompactions: FULL ? 1 : 0,
        beforeSettle: FULL ? 1 : 0,
      },
      sendWhileRunning: false,
      zombie: true,
    },
    min: FULL ? 3_000 : 150,
  },
  {
    name: '预检拒收：失败终态先于拒收回执，与中断、重试、僵尸时限交错',
    cfg: {
      prompts: FULL ? 3 : 2,
      aborts: 1,
      abortRetries: FULL ? 1 : 0,
      budget: { errors: 1, overflows: 0, memCompactions: 0, beforeSettle: 0 },
      sendWhileRunning: true,
      zombie: true,
      rejects: 1,
    },
    min: FULL ? 1_000 : 250,
  },
];

describe('worker 轮次相位（有界穷举，驱动真实 SessionSupervisor）', () => {
  it.each(core)(
    '每轮恰好一个终态、终态后不再自行续跑、每条 prompt 恰好送达一次：$name',
    async ({ cfg, min }) => {
      const result = await explore(cfg);
      expect(report(result)).toBe('');
      expect(result.states).toBeGreaterThan(min);
    },
    FULL ? 900_000 : 120_000
  );
});
