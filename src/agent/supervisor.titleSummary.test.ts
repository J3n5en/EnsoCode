import type { AgentWorkerEvent } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  /** 让某个 modelId 在 getModel 阶段就找不到（模拟 worker catalog 缺模型） */
  missingModelIds: new Set<string>(),
}));

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

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const runtime = {
    models: new Map<string, Record<string, unknown>>(),
    registerProvider(providerId: string, config: { models?: Record<string, unknown>[] }) {
      for (const model of config.models ?? []) {
        this.models.set(`${providerId}/${model.id}`, { ...model, provider: providerId });
      }
    },
    getModel(providerId: string, modelId: string) {
      if (mocks.missingModelIds.has(modelId)) return undefined;
      return this.models.get(`${providerId}/${modelId}`);
    },
    getModels() {
      return [...this.models.values()];
    },
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    completeSimple: mocks.completeSimple,
  };
  return {
    ...original,
    ModelRuntime: { create: vi.fn(async () => runtime) },
  };
});

import { SessionSupervisor } from './supervisor';

const candidate = (modelId: string) => ({
  api: 'openai-completions' as const,
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  modelId,
  settingsProviderId: `provider-${modelId}`,
});

const text = (value: string, stopReason = 'stop') => ({
  role: 'assistant',
  content: [{ type: 'text', text: value }],
  stopReason,
});

/** 永不 resolve、只响应 abort 的补全：模拟慢模型 */
function hanging(): (model: unknown, context: unknown, options: { signal: AbortSignal }) => Promise<unknown> {
  return (_model, _context, { signal }) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(text('', 'aborted')), { once: true });
    });
}

/** 排空微任务 + 已到期的 timer；fake timers 下纯 await Promise.resolve() 的次数不好预估 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

describe('SessionSupervisor.summarizeTitle：候选依次尝试', () => {
  let events: AgentWorkerEvent[];
  let supervisor: SessionSupervisor;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.completeSimple.mockReset();
    mocks.missingModelIds.clear();
    events = [];
    supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: '/tmp/agent',
      sessionDir: '/tmp/sessions',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const command = (candidates: ReturnType<typeof candidate>[]) =>
    ({
      type: 'summarize-title',
      conversationId: 'conversation-1',
      input: { kind: 'initial', text: '帮我修一下节点转圈的问题' },
      candidates,
    }) as const;

  it('#0 超时（60s）→ #1 返回合法标题 → 只发一次 title-generated，不再调 #2', async () => {
    mocks.completeSimple
      .mockImplementationOnce(hanging())
      .mockResolvedValueOnce(text('修复节点状态转圈'))
      .mockResolvedValueOnce(text('不该被调用'));

    supervisor.handleCommand(command([candidate('slow'), candidate('good'), candidate('spare')]));
    await flush();
    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);

    // 59s：仍在等 #0
    await vi.advanceTimersByTimeAsync(59_000);
    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    // 60s：#0 abort → 切到 #1
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();

    expect(mocks.completeSimple).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      { type: 'title-generated', conversationId: 'conversation-1', title: '修复节点状态转圈' },
    ]);
  });

  it('#0 返回多句叙述（不像标题）→ 走 #1', async () => {
    mocks.completeSimple
      .mockResolvedValueOnce(text('继续排查节点一直转圈的问题。我先查看当前代码。然后确认修复'))
      .mockResolvedValueOnce(text('修复节点状态转圈'));

    supervisor.handleCommand(command([candidate('chatty'), candidate('good')]));
    await flush();

    expect(mocks.completeSimple).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      { type: 'title-generated', conversationId: 'conversation-1', title: '修复节点状态转圈' },
    ]);
  });

  it('#0 模型在 worker catalog 里找不到（resolve 抛错）→ 走 #1', async () => {
    mocks.missingModelIds.add('ghost');
    mocks.completeSimple.mockResolvedValueOnce(text('修复节点状态转圈'));

    supervisor.handleCommand(command([candidate('ghost'), candidate('good')]));
    await flush();
    await flush();

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: 'title-generated', conversationId: 'conversation-1', title: '修复节点状态转圈' },
    ]);
  });

  it('#0 stopReason=error → 走 #1，失败原因带模型标识', async () => {
    mocks.completeSimple
      .mockResolvedValueOnce({ ...text(''), stopReason: 'error', errorMessage: '401 unauthorized' })
      .mockResolvedValueOnce(text('', 'error'));

    supervisor.handleCommand(command([candidate('a'), candidate('b')]));
    await flush();

    expect(events).toEqual([
      {
        type: 'title-failed',
        conversationId: 'conversation-1',
        error: 'provider-b/b: model error',
      },
    ]);
  });

  it('全部超时 → title-failed，error 以最后候选标识开头且含 timed out after 180s；超时档位 60/120/180', async () => {
    mocks.completeSimple.mockImplementation(hanging());

    supervisor.handleCommand(command([candidate('a'), candidate('b'), candidate('c')]));
    await flush();
    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(mocks.completeSimple).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(119_000);
    await flush();
    expect(mocks.completeSimple).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(mocks.completeSimple).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(180_000);
    await flush();

    expect(events).toEqual([
      {
        type: 'title-failed',
        conversationId: 'conversation-1',
        error: 'provider-c/c: timed out after 180s',
      },
    ]);
  });

  it('单候选成功 → 不发 title-failed', async () => {
    mocks.completeSimple.mockResolvedValueOnce(text('「修复节点状态转圈」'));
    supervisor.handleCommand(command([candidate('only')]));
    await flush();
    expect(events).toEqual([
      { type: 'title-generated', conversationId: 'conversation-1', title: '修复节点状态转圈' },
    ]);
  });
});
