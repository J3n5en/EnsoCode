import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { SHELL_LIMITS } from '@shared/shellLimits';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  createAgentSession: vi.fn(),
  loaderOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('./cursor/loadProvider', () => ({
  CURSOR_PROVIDER_ID: 'cursor',
  loadCursorProvider: vi.fn(async () => undefined),
}));

vi.mock('./mcp', () => ({
  McpManager: class {
    toolsFor = vi.fn(async () => []);
    resolve = vi.fn();
    refresh = vi.fn();
    closeAll = vi.fn(async () => undefined);
  },
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  class Loader {
    constructor(options: Record<string, unknown>) {
      mocks.loaderOptions.push(options);
    }
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
      getBranch: vi.fn(() => branch),
      appendCustomEntry: vi.fn((customType: string, data: unknown) => {
        branch.push({ type: 'custom', customType, data });
        return `entry-${branch.length}`;
      }),
      buildSessionContext: vi.fn(() => ({ messages: [] })),
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
    resolveModel: vi.fn<ModelRuntime['resolveModel']>(),
    getAuth: vi.fn<ModelRuntime['getAuth']>().mockResolvedValue(undefined),
    getProvider(providerId: string) {
      if (![...this.models.keys()].some((key) => key.startsWith(`${providerId}/`)))
        return undefined;
      return { id: providerId, models: [], stream: vi.fn(), streamSimple: vi.fn() };
    },
    registerNativeProvider: vi.fn(),
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    completeSimple: vi.fn(async () => ({ content: [] })),
  };
  return {
    ...original,
    DefaultResourceLoader: Loader,
    ModelRuntime: { create: vi.fn(async () => runtime) },
    SessionManager: { create: vi.fn(manager), open: vi.fn(manager), inMemory: vi.fn(manager) },
    createAgentSession: mocks.createAgentSession,
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

type Tool = {
  name: string;
  execute(id: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
};
type FakeSession = {
  prompt: ReturnType<typeof vi.fn>;
  messages: unknown[];
  isCompacting: boolean;
  emit(event: { type: string; [key: string]: unknown }): void;
};

function session(options: Record<string, unknown>) {
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const value = {
    model: options.model,
    resourceLoader: options.resourceLoader,
    sessionManager: options.sessionManager,
    messages: [] as unknown[],
    agent: { state: { messages: [] } },
    sessionFile: `/tmp/session-${mocks.sessions.length}.jsonl`,
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(event: { type: string; [key: string]: unknown }) {
      for (const listener of listeners) listener(event);
    },
    prompt: vi.fn(
      async (_text: string, options?: { preflightResult?: (disposition: string) => void }) => {
        options?.preflightResult?.('started');
      }
    ),
    steer: vi.fn(async () => 'queued'),
    abort: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
    activeTools: ((options.customTools as Array<{ name: string }> | undefined) ?? []).map(
      (tool) => tool.name
    ),
    getActiveToolNames(this: { activeTools: string[] }) {
      return [...this.activeTools];
    },
    setActiveToolsByName: vi.fn(function (this: { activeTools: string[] }, names: string[]) {
      this.activeTools = [...names];
    }),
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    isStreaming: false,
    isRetrying: false,
    isCompacting: false,
  };
  mocks.sessions.push(value);
  return value;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const promptTexts = (target: FakeSession) =>
  target.prompt.mock.calls.map((call) => String(call[0] ?? ''));

const notificationPrompts = (target: FakeSession) =>
  promptTexts(target).filter((text) => text.includes('<agent-notification>'));

describe('后台任务完成通知送达（唤醒保证）', () => {
  let cleanup: Array<() => Promise<void>> = [];
  beforeEach(() => {
    mocks.sessions.length = 0;
    mocks.loaderOptions.length = 0;
    mocks.createAgentSession.mockReset();
    mocks.createAgentSession.mockImplementation(async (options: Record<string, unknown>) => ({
      session: session(options),
    }));
  });
  afterEach(async () => {
    for (const fn of cleanup) await fn();
    cleanup = [];
  });

  async function setup() {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'enso-notify-')));
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: path.join(cwd, 'agent'),
      sessionDir: path.join(cwd, 'sessions'),
    });
    cleanup.push(() => supervisor.shutdown());
    supervisor.handleCommand({
      type: 'spawn-parent',
      identity: parent,
      cwd,
      model,
      approvalMode: 'full',
    });
    await until(() => events.some((event) => event.type === 'parent-ready'));
    const [parentSession] = mocks.sessions as unknown as FakeSession[];
    const bash = (
      mocks.createAgentSession.mock.calls[0]?.[0] as { customTools: Tool[] } | undefined
    )?.customTools.find((tool) => tool.name === 'bash') as Tool;
    return { cwd, events, supervisor, parentSession, bash };
  }

  const finished = (target: FakeSession, needle: string) =>
    notificationPrompts(target).some((text) => text.includes(needle));

  it('空闲会话的后台任务完成（exit 0）：合成提示唤醒会话', async () => {
    const ctx = await setup();
    await ctx.bash.execute('call-1', { command: 'echo quick-done', background: true });
    await until(() => finished(ctx.parentSession, 'quick-done'), 4000);
  });

  it('空闲会话的后台任务失败（exit 非 0）：照样唤醒会话', async () => {
    const ctx = await setup();
    await ctx.bash.execute('call-1', { command: 'echo failing-out; exit 3', background: true });
    await until(() => finished(ctx.parentSession, 'failing-out'), 4000);
  });

  it('前台移交后台的任务到 timeout 被杀：照样唤醒会话', async () => {
    const ctx = await setup();
    // 前台让位立即发生，任务在 1s deadline 到点被杀
    ctx.supervisor.handleCommand({
      type: 'set-shell-limits',
      limits: { ...SHELL_LIMITS, yieldDefaultMs: 10 },
    });
    const exec = ctx.bash.execute('call-1', { command: 'sleep 5', timeout: 1 });
    await until(() => ctx.events.some((event) => event.type === 'task-ended'), 5000);
    await exec.catch(() => undefined);
    await until(
      () => notificationPrompts(ctx.parentSession).some((text) => text.includes('timeout')),
      4000
    );
  });

  it('压缩期间完成的后台任务：压缩一结束就补投唤醒，不永久挂在 pending（线上 9dc6ca54 类事故的复现）', async () => {
    const ctx = await setup();
    // 空闲会话进入压缩（自动记忆压缩 / 手动 /compact 同路径）：pi 此刻拒绝 prompt
    ctx.parentSession.isCompacting = true;
    // pi 的 prompt 在压缩中同步拒绝（throw before first await）：真实复现时的投递被拒路径
    ctx.parentSession.prompt.mockImplementation(() => {
      return Promise.reject(
        new Error(
          'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.'
        )
      );
    });
    ctx.parentSession.emit({ type: 'compaction_start', reason: 'manual' });

    await ctx.bash.execute('call-1', { command: 'echo compaction-window-done', background: true });
    await until(() => ctx.events.some((event) => event.type === 'task-ended'), 5000);
    // 压缩结束：必须有一次新的投递唤起会话，会话不该干等已结束的命令。
    // 压缩期间被拒的尝试也计入了调用记录，断言压缩结束之后必有新的一轮。
    ctx.parentSession.isCompacting = false;
    ctx.parentSession.prompt.mockImplementation(async () => undefined);
    const before = ctx.parentSession.prompt.mock.calls.length;
    ctx.parentSession.emit({ type: 'compaction_end' });
    await until(
      () =>
        ctx.parentSession.prompt.mock.calls
          .slice(before)
          .some((call) => String(call[0] ?? '').includes('compaction-window-done')),
      4000
    );
  });
});
