import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  type Provider,
} from '@earendil-works/pi-ai';
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { OauthPoolFailure } from '@shared/oauthAccountPool';
import type { AgentCommand, SpawnModelConfig } from '@shared/types/agent';
import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_POOL_EXHAUSTED, OauthAccountPool } from '../main/services/oauthAccountPool';
import {
  failureForMessage,
  installOauthPoolSelector,
  type OauthPoolSelector,
  oauthPoolRecoveryExtension,
  releaseOauthPoolSession,
  resolveOauthPoolModel,
} from './oauthAccountPool';
import { SessionSupervisor } from './supervisor';

const keys = ['openai-codex', 'openai-codex#2'];
const config: SpawnModelConfig = {
  api: 'openai-responses',
  apiKey: '',
  baseUrl: '',
  modelId: 'pool-fixture',
  settingsProviderId: 'pool',
  oauthAccountKey: keys[0],
  oauthAccountPool: { accountKeys: keys },
};
const roots: string[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) {
    releaseOauthPoolSession(session.sessionId);
    session.dispose();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Request {
  key: string;
  baseUrl: string;
  modelJson: string;
  messages: Context['messages'];
  transport?: string;
  reasoning?: string;
  signal?: AbortSignal;
}
type Reply = 'tool' | 'ok' | 'quota' | 'auth' | 'rate' | 'stream-quota' | 'wait-abort';

async function fixture(
  replies: Reply[],
  selectorOverride?: OauthPoolSelector,
  accountKeys: string[] = keys,
  requestGate?: (index: number) => Promise<void>,
  beforeInstall?: (runtime: ModelRuntime) => void
) {
  const keys = accountKeys;
  const root = mkdtempSync(path.join(tmpdir(), 'enso-pool-sdk-'));
  roots.push(root);
  const cwd = path.join(root, 'cwd');
  const agentDir = path.join(root, 'agent');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const credentials = new InMemoryCredentialStore();
  for (const key of keys)
    await credentials.modify(key, async () => ({ type: 'api_key', key: 'fixture-not-real' }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider(keys[0], {
    api: 'openai-completions',
    apiKey: 'fixture-not-real',
    baseUrl: 'https://fixture.invalid',
    models: [
      {
        id: config.modelId,
        name: 'fixture',
        reasoning: true,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const original = runtime.getProvider(keys[0]);
  if (!original) throw new Error('fixture provider missing');
  const requests: Request[] = [];
  const streamWaiting = Promise.withResolvers<void>();
  let toolCalls = 0;
  let responseReply: Reply = 'quota';
  vi.stubGlobal('fetch', async () =>
    Response.json(
      {
        error: {
          code:
            responseReply === 'auth'
              ? 'invalid_token'
              : responseReply === 'rate'
                ? 'rate_limit_exceeded'
                : 'usage_limit_reached',
          resets_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      { status: responseReply === 'auth' ? 401 : 429 }
    )
  );
  const fakeStream: Provider['streamSimple'] = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    requests.push({
      key: model.provider,
      baseUrl: model.baseUrl,
      modelJson: JSON.stringify(model),
      messages: structuredClone(context.messages),
      transport: options?.transport,
      reasoning: options?.reasoning,
      signal: options?.signal,
    });
    const requestIndex = requests.length - 1;
    void (async () => {
      const reply = replies.shift() ?? 'ok';
      responseReply = reply;
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        stopReason: 'stop',
        timestamp: Date.now(),
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      await requestGate?.(requestIndex);
      if (reply === 'wait-abort') {
        if (!options?.signal) throw new Error('SDK request signal missing');
        streamWaiting.resolve();
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        message.stopReason = 'aborted';
        message.errorMessage = 'fixture cancelled';
      } else if (reply === 'quota' || reply === 'auth' || reply === 'rate') {
        if (reply === 'quota') await options?.fetch?.('https://fixture.invalid/error');
        else await options?.fetch?.('https://fixture.invalid/error');
        message.stopReason = 'error';
        message.errorMessage = 'You have hit your ChatGPT usage limit.';
      } else if (reply === 'stream-quota') {
        await options?.onProviderStreamEvent?.(
          {
            type: 'response.failed',
            response: {
              error: {
                code: 'usage_limit_reached',
                resets_at: Math.floor(Date.now() / 1000) + 3600,
              },
            },
          },
          model
        );
        message.stopReason = 'error';
        message.errorMessage = 'provider error';
      } else if (reply === 'tool') {
        message.stopReason = 'toolUse';
        message.content = [{ type: 'toolCall', id: 'tool-once', name: 'once', arguments: {} }];
      } else message.content = [{ type: 'text', text: 'finished' }];
      if (message.stopReason === 'error' || message.stopReason === 'aborted')
        stream.push({ type: 'error', reason: message.stopReason, error: message });
      else
        stream.push({
          type: 'done',
          reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
          message,
        });
      stream.end(message);
    })();
    return stream;
  };
  runtime.registerNativeProvider({
    ...original,
    streamSimple: fakeStream,
    stream: fakeStream as Provider['stream'],
  });
  const pool = new OauthAccountPool();
  const failures: OauthPoolFailure[] = [];
  const select: OauthPoolSelector =
    selectorOverride ??
    (async (id, _model, failed, _signal, excluded) => {
      if (failed) failures.push(failed);
      const selected = pool.select(
        id,
        keys,
        keys.filter((key) => !excluded?.includes(key)),
        failed
      );
      if (!selected) throw new Error(OAUTH_POOL_EXHAUSTED);
      return selected;
    });
  beforeInstall?.(runtime);
  installOauthPoolSelector(runtime, select);
  const notices: Array<{ key: string; previous?: string; scope?: unknown }> = [];
  const model = resolveOauthPoolModel(runtime, {
    ...config,
    oauthAccountKey: keys[0],
    oauthAccountPool: { accountKeys: keys },
  });
  await runtime.refresh({ providers: keys, allowNetwork: false });
  const create = async (selectedModel: Model<Api> = model, resumeFile?: string) => {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: 'Fixture only.',
      extensionFactories: [
        oauthPoolRecoveryExtension(select, (_id, key, previous, ...rest: unknown[]) =>
          notices.push({ key, previous, ...(rest[0] ? { scope: rest[0] } : {}) })
        ),
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model: selectedModel,
      thinkingLevel: 'high',
      resourceLoader: loader,
      sessionManager: resumeFile
        ? SessionManager.open(resumeFile)
        : SessionManager.create(cwd, path.join(root, 'sessions')),
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
      noTools: 'builtin',
      customTools: [
        {
          name: 'once',
          label: 'once',
          description: 'Fixture',
          parameters: Type.Object({}),
          execute: async () => {
            toolCalls++;
            return { content: [{ type: 'text', text: 'tool completed once' }], details: {} };
          },
        },
      ],
    });
    sessions.push(session);
    return session;
  };
  return {
    runtime,
    credentials,
    fakeStream,
    model,
    create,
    requests,
    failures,
    notices,
    toolCalls: () => toolCalls,
    streamWaiting: streamWaiting.promise,
  };
}

/**
 * 只替换 supervisor 的会话查找和投影出口；retry 分支、SDK、扩展和 provider 均运行真实实现。
 *
 * Replace only supervisor lookup/projection sinks; run the real retry branch, SDK, extension and provider.
 */
async function manualRetry(session: AgentSession): Promise<void> {
  const managed = { session, status: 'idle', currentTurnId: undefined };
  const done = Promise.withResolvers<void>();
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'agent_settled') done.resolve();
  });
  const supervisor = Object.assign(Object.create(SessionSupervisor.prototype), {
    must: () => managed,
    onSessionEvent: () => done.resolve(),
    failTurn: (_managed: unknown, error: string) => done.reject(new Error(error)),
  }) as { execute(command: AgentCommand): Promise<void> };
  try {
    await supervisor.execute({
      type: 'retry',
      identity: { sessionId: session.sessionId, generation: 'fixture' },
    });
    await done.promise;
  } finally {
    unsubscribe();
  }
}

describe('真实 SDK 的假 provider 顺序接替', () => {
  it('安装 selector 后普通账号鉴权直接返回 SDK 的原 promise，不添加异步跳数', async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const auth = { auth: { apiKey: 'fixture-not-real' } };
    const pending = Promise.withResolvers<typeof auth>();
    const getAuth = vi.spyOn(runtime, 'getAuth').mockReturnValue(pending.promise);
    const select = vi.fn<OauthPoolSelector>();
    installOauthPoolSelector(runtime, select);
    const model = { provider: 'ordinary-provider' } as Model<Api>;
    const options = { signal: new AbortController().signal };
    const byProvider = runtime.getAuth(model.provider, options);
    const byModel = runtime.getAuth(model, options);
    pending.resolve(auth);
    expect(await byProvider).toBe(auth);
    expect(await byModel).toBe(auth);
    expect(getAuth.mock.calls).toEqual([
      [model.provider, options],
      [model, options],
    ]);
    expect(select).not.toHaveBeenCalled();
    expect(byProvider).toBe(pending.promise);
    expect(byModel).toBe(pending.promise);
  });

  it.each([
    { reply: 'quota', missing: false },
    { reply: 'stream-quota', missing: false },
    { reply: 'quota', missing: true },
  ] as const)(
    '$reply并发同key逆序失败回传当次receipt（缺票=$missing），不使用latest票',
    async ({ reply, missing }) => {
      const receipts = [
        '11111111-1111-4111-8111-111111111111',
        missing ? undefined : '22222222-2222-4222-8222-222222222222',
      ];
      const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const observed: OauthPoolFailure[] = [];
      let selections = 0;
      const select: OauthPoolSelector = async (_id, _model, failed) => {
        if (failed) {
          observed.push(failed);
          return keys[1];
        }
        if (selections >= receipts.length) return keys[1];
        return { accountKey: keys[0], selectionReceipt: receipts[selections++] };
      };
      const f = await fixture([reply, reply, 'ok', 'ok'], select, keys, async (index) => {
        if (index < 2) await gates[index].promise;
      });
      const first = await f.create();
      const second = await f.create();
      const firstPrompt = first.prompt('first');
      await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 500 });
      const secondPrompt = second.prompt('second');
      await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 500 });
      gates[1].resolve();
      await secondPrompt;
      gates[0].resolve();
      await firstPrompt;
      expect(observed.map((failure) => failure.selectionReceipt)).toEqual([
        receipts[1],
        receipts[0],
      ]);
      expect(observed.every((failure) => failure.accountKey === keys[0])).toBe(true);
      expect(f.requests.map((request) => request.key)).toEqual([
        keys[0],
        keys[0],
        keys[1],
        keys[1],
      ]);
    }
  );
  it.each([1, 2])('第%d次getAuth刷新失败回传自己的receipt（路由/prepare阶段）', async (failOn) => {
    const selectionReceipt = '33333333-3333-4333-8333-333333333333';
    const observed: OauthPoolFailure[] = [];
    const select: OauthPoolSelector = async (_id, _model, failed) => {
      if (failed) {
        observed.push(failed);
        return keys[1];
      }
      if (observed.length) return keys[1];
      return { accountKey: keys[0], selectionReceipt };
    };
    let calls = 0;
    const f = await fixture(['ok'], select, keys, undefined, (runtime) => {
      const originalGetAuth = runtime.getAuth.bind(runtime);
      vi.spyOn(runtime, 'getAuth').mockImplementation(async (model, options) => {
        if (typeof model === 'string') return originalGetAuth(model, options);
        if (model.provider === keys[0] && ++calls === failOn)
          throw new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}');
        return originalGetAuth(model, options);
      });
    });
    const session = await f.create();
    await session.prompt('original task');
    expect(observed).toEqual([{ accountKey: keys[0], reason: 'login-invalid', selectionReceipt }]);
    expect(f.requests.map((request) => request.key)).toEqual([keys[1]]);
  });
  it('SDK prepareRequest的baseUrl spread保留请求票据，但model JSON与journal不含票据', async () => {
    const selectionReceipt = '44444444-4444-4444-8444-444444444444';
    const observed: OauthPoolFailure[] = [];
    const select: OauthPoolSelector = async (_id, _model, failed) => {
      if (failed) {
        observed.push(failed);
        throw new Error(OAUTH_POOL_EXHAUSTED);
      }
      return { accountKey: keys[0], selectionReceipt };
    };
    const f = await fixture(['quota'], select);
    const originalGetAuth = f.runtime.getAuth.bind(f.runtime);
    const getAuth = vi.spyOn(f.runtime, 'getAuth').mockImplementation(async (model, options) => {
      const auth =
        typeof model === 'string'
          ? await originalGetAuth(model, options)
          : await originalGetAuth(model, options);
      return auth
        ? { ...auth, auth: { ...auth.auth, baseUrl: 'https://spread.fixture.invalid' } }
        : auth;
    });
    const session = await f.create();
    await session.prompt('task');
    expect(f.requests[0].baseUrl).toBe('https://spread.fixture.invalid');
    expect(observed[0].selectionReceipt).toBe(selectionReceipt);
    expect(f.requests[0].modelJson).not.toContain(selectionReceipt);
    expect(JSON.stringify(session.sessionManager.getBranch())).not.toContain(selectionReceipt);
    getAuth.mockRestore();
  });
  it('结算边界候选票不冒充后续真实请求票', async () => {
    const receipts = [
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777',
    ];
    const observed: OauthPoolFailure[] = [];
    let selections = 0;
    const select: OauthPoolSelector = async (_id, _model, failed) => {
      if (failed) observed.push(failed);
      if (selections === 3) throw new Error(OAUTH_POOL_EXHAUSTED);
      const index = selections++;
      return { accountKey: index === 0 ? keys[0] : keys[1], selectionReceipt: receipts[index] };
    };
    const f = await fixture(['quota', 'stream-quota'], select);
    const session = await f.create();
    await session.prompt('task');
    expect(f.requests.map((request) => request.key)).toEqual(keys);
    expect(observed.map((failure) => failure.selectionReceipt)).toEqual([receipts[0], receipts[2]]);
  });
  it('公开adapter仅安装一次，普通固定模型不改身份且不继承pool receipt', async () => {
    const f = await fixture(['auth']);
    const resolveModel = f.runtime.resolveModel;
    installOauthPoolSelector(f.runtime, async () => ({
      accountKey: keys[0],
      selectionReceipt: '88888888-8888-4888-8888-888888888888',
    }));
    expect(f.runtime.resolveModel).toBe(resolveModel);
    const fixed = f.runtime.getModel(keys[0], config.modelId)!;
    f.runtime.registerVirtualModel({
      provider: 'other-virtual',
      id: 'v',
      name: 'other',
      route: () => ({ model: fixed, thinkingLevel: 'off' }),
    });
    const other = f.runtime.getModel('other-virtual', 'v')!;
    const resolved = await f.runtime.resolveModel(other, [], {
      reason: 'direct',
      thinkingLevel: 'off',
    });
    expect(resolved.model).toStrictEqual(fixed);
    const session = await f.create(fixed);
    await session.prompt('fixed');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].transport).not.toBe('sse');
    expect(failureForMessage(session.messages.at(-1) as AssistantMessage)).toBeUndefined();
  });
  it.each([2, 3])(
    '手动retry前%d账号硬额度耗尽：原任务与已完成工具不重放，SDK只结算一次',
    async (failedCount) => {
      const fourKeys = [...keys, 'openai-codex#3', 'openai-codex#4'];
      const f = await fixture(
        ['tool', 'rate', ...Array<Reply>(failedCount).fill('quota'), 'ok'],
        undefined,
        fourKeys
      );
      const session = await f.create();
      await session.prompt('original task');
      const settled: string[] = [];
      session.subscribe((event) => {
        if (event.type === 'agent_settled') settled.push(event.type);
      });
      await manualRetry(session);
      expect(f.requests.map((request) => request.key)).toEqual([
        fourKeys[0],
        fourKeys[0],
        ...fourKeys.slice(0, failedCount + 1),
      ]);
      for (const request of f.requests.slice(2)) {
        expect(request.messages.filter((message) => message.role === 'user')).toHaveLength(1);
        expect(request.messages.filter((message) => message.role === 'toolResult')).toHaveLength(1);
        expect(request.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
        expect(request.reasoning).toBe('high');
        expect(request.transport).toBe('sse');
      }
      expect(f.toolCalls()).toBe(1);
      expect(settled).toHaveLength(1);
      expect(session.messages.at(-1)?.role).toBe('assistant');
      expect((session.messages.at(-1) as AssistantMessage).stopReason).toBe('stop');
      expect(session.isIdle).toBe(true);
    }
  );

  it('恢复后没有before_agent_start也能直接retry：结构化错误接替与路由通知仍可用', async () => {
    const f = await fixture(['ok', 'quota', 'ok']);
    const original = await f.create();
    await original.prompt('persisted task');
    const file = original.sessionFile;
    if (!file) throw new Error('fixture session was not persisted');
    original.dispose();
    releaseOauthPoolSession(original.sessionId);
    f.notices.length = 0;
    const session = await f.create(f.model, file);
    await manualRetry(session);
    expect(f.requests.map((request) => request.key)).toEqual([keys[0], ...keys]);
    expect(f.failures).toHaveLength(1);
    expect(f.notices.map((notice) => notice.key)).toEqual(keys);
    expect(f.requests.at(-1)?.messages.filter((message) => message.role === 'user')).toHaveLength(
      1
    );
  });

  it('manual retry是新活动：冷却到期后复位attempted，自动续跑仍排除同活动失败账号', async () => {
    let now = Date.now();
    const pool = new OauthAccountPool(() => now);
    const select: OauthPoolSelector = async (id, _model, failed, _signal, excluded) => {
      if (failed) now += 4_000_000;
      const selected = pool.select(
        id,
        keys,
        keys.filter((key) => !excluded?.includes(key)),
        failed
      );
      if (!selected) throw new Error(OAUTH_POOL_EXHAUSTED);
      return selected;
    };
    const f = await fixture(['quota', 'quota', 'quota', 'ok'], select);
    const session = await f.create();
    await session.prompt('original task');
    expect(f.requests.map((request) => request.key)).toEqual(keys);
    now += 4_000_000;
    let settled = 0;
    session.subscribe((event) => {
      if (event.type === 'agent_settled') settled++;
    });
    await manualRetry(session);
    expect(f.requests.map((request) => request.key)).toEqual([...keys, keys[1], keys[0]]);
    expect(f.requests.at(-1)?.messages.filter((message) => message.role === 'user')).toHaveLength(
      1
    );
    expect((session.messages.at(-1) as AssistantMessage).stopReason).toBe('stop');
    expect(settled).toBe(1);
  });

  it('manual retry在结算前选号时abort：延迟结果不启动续跑，SDK只结算一次', async () => {
    const entered = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const select: OauthPoolSelector = async (_id, _model, failed) => {
      if (!failed) return keys[0];
      entered.resolve();
      await unblock.promise;
      return keys[1];
    };
    const f = await fixture(['rate', 'quota', 'ok'], select);
    const session = await f.create();
    await session.prompt('task');
    let settled = 0;
    session.subscribe((event) => {
      if (event.type === 'agent_settled') settled++;
    });
    const retry = manualRetry(session);
    const phase = await Promise.race([
      entered.promise.then(() => 'selecting'),
      retry.then(() => 'finished'),
    ]);
    expect(phase).toBe('selecting');
    expect(session.isStreaming).toBe(true);
    const abort = session.abort();
    unblock.resolve();
    await Promise.all([retry, abort]);
    expect(f.requests).toHaveLength(2);
    expect(settled).toBe(1);
    expect(session.isIdle).toBe(true);
  });

  it('manual retry请求中abort透传SDK signal：不换账号、不重放任务、只结算一次', async () => {
    const f = await fixture(['rate', 'wait-abort', 'ok']);
    const session = await f.create();
    await session.prompt('task');
    let settled = 0;
    session.subscribe((event) => {
      if (event.type === 'agent_settled') settled++;
    });
    const retry = manualRetry(session);
    await f.streamWaiting;
    const signal = f.requests.at(-1)?.signal;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    await Promise.all([session.abort(), retry]);
    expect(signal?.aborted).toBe(true);
    expect(f.requests).toHaveLength(2);
    expect(f.requests.at(-1)?.messages.filter((message) => message.role === 'user')).toHaveLength(
      1
    );
    expect(f.failures).toHaveLength(0);
    expect(settled).toBe(1);
    expect((session.messages.at(-1) as AssistantMessage).stopReason).toBe('aborted');
    expect(session.isIdle).toBe(true);
  });

  it('同账号换池后发请求也重新通知真实路由身份，不重复同池通知', async () => {
    const f = await fixture(['ok', 'ok', 'ok']);
    const session = await f.create();
    expect(f.notices).toEqual([]);
    await session.prompt('first');
    await session.prompt('same pool');
    expect(f.notices).toHaveLength(1);
    const next = resolveOauthPoolModel(f.runtime, { ...config, settingsProviderId: 'pool-other' });
    await session.setModel(next);
    expect(f.notices).toHaveLength(1);
    await session.prompt('other pool');
    expect(f.notices).toEqual([
      {
        key: keys[0],
        previous: undefined,
        scope: { settingsProviderId: 'pool', modelId: config.modelId },
      },
      {
        key: keys[0],
        previous: undefined,
        scope: { settingsProviderId: 'pool-other', modelId: config.modelId },
      },
    ]);
  });
  it('OAuth刷新invalid_grant在provider stream前发生，仍用同任务下一有效账号', async () => {
    const f = await fixture(['ok']);
    await f.credentials.modify(keys[0], async () => ({
      type: 'oauth',
      access: 'fixture-access',
      refresh: 'fixture-refresh',
      expires: 1,
    }));
    await f.credentials.modify(keys[1], async () => ({
      type: 'oauth',
      access: 'fixture-access-2',
      refresh: 'fixture-refresh-2',
      expires: Date.now() + 3_600_000,
    }));
    vi.stubGlobal('fetch', async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    await f.runtime.refresh({ providers: keys, allowNetwork: false });
    const session = await f.create();
    await session.prompt('original task');
    expect(f.requests.map((request) => request.key)).toEqual([keys[1]]);
    expect(f.requests[0].messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(f.failures).toEqual([{ accountKey: keys[0], reason: 'login-invalid' }]);
  });
  it('刷新网络错误不标记登录失效、不越权换号', async () => {
    const f = await fixture(['ok']);
    const getAuth = vi
      .spyOn(f.runtime, 'getAuth')
      .mockRejectedValue(
        new Error('OAuth refresh failed for openai-codex', { cause: new Error('fetch failed') })
      );
    const session = await f.create();
    await session.prompt('task');
    expect(f.requests).toHaveLength(0);
    expect(f.failures).toHaveLength(0);
    expect(f.notices).toHaveLength(0);
    expect((session.messages.at(-1) as AssistantMessage).errorMessage).toContain(
      'OAuth refresh failed'
    );
    getAuth.mockRestore();
  });
  it('Main实时新增的已有fixed成员也会适配结构化错误', async () => {
    let current = keys[0];
    const third = 'openai-codex#3';
    const select: OauthPoolSelector = async (_id, _model, failed, _signal, excluded) => {
      if (failed) current = third;
      if (excluded?.includes(current)) throw new Error(OAUTH_POOL_EXHAUSTED);
      return current;
    };
    const f = await fixture(['quota', 'quota'], select);
    f.runtime.registerProvider(third, {
      api: 'openai-completions',
      apiKey: 'fixture-only',
      baseUrl: 'https://fixture.invalid',
      models: [{ ...f.runtime.getModel(keys[0], config.modelId)!, id: config.modelId }],
    });
    const provider = f.runtime.getProvider(third);
    if (!provider) throw new Error('missing');
    f.runtime.registerNativeProvider({
      ...provider,
      streamSimple: f.fakeStream,
      stream: f.fakeStream as Provider['stream'],
    });
    await f.runtime.setRuntimeApiKey(third, 'fixture-only');
    const session = await f.create();
    await session.prompt('task');
    expect(f.requests.map((request) => request.key)).toEqual([keys[0], third]);
    expect((session.messages.at(-1) as AssistantMessage).errorMessage).toContain(
      'No available ChatGPT'
    );
  });
  it('冷却时钟跨越整个窗口也不得在同活动中循环已失败账号', async () => {
    let now = Date.now();
    const pool = new OauthAccountPool(() => now);
    const select: OauthPoolSelector = async (id, _model, failed, _signal, excluded) => {
      if (failed) now += 4_000_000;
      const selected = pool.select(
        id,
        keys,
        keys.filter((key) => !excluded?.includes(key)),
        failed
      );
      if (!selected) throw new Error(OAUTH_POOL_EXHAUSTED);
      return selected;
    };
    const f = await fixture(['quota', 'quota', 'quota'], select);
    const session = await f.create();
    await session.prompt('task');
    expect(f.requests).toHaveLength(2);
    expect((session.messages.at(-1) as AssistantMessage).errorMessage).toContain(
      'No available ChatGPT'
    );
    now += 4_000_000;
    await session.prompt('next activity');
    expect(f.requests.length).toBeGreaterThan(2);
    expect((session.messages.at(-1) as AssistantMessage).stopReason).toBe('stop');
  });
  it('工具已完成后硬额度错误结算前续跑：任务不重发、工具只一次、推理保持', async () => {
    const f = await fixture(['tool', 'quota', 'ok']);
    const session = await f.create();
    const settled: string[] = [];
    session.subscribe((event) => {
      if (event.type === 'agent_settled') settled.push(event.type);
    });
    await session.prompt('original task');
    expect(f.requests.map((request) => request.key)).toEqual([keys[0], keys[0], keys[1]]);
    expect(f.requests.at(-1)?.messages.filter((message) => message.role === 'user')).toHaveLength(
      1
    );
    expect(f.requests.at(-1)?.messages.some((message) => message.role === 'toolResult')).toBe(true);
    expect(f.toolCalls()).toBe(1);
    expect(settled).toHaveLength(1);
    expect(session.messages.at(-1)?.role).toBe('assistant');
    expect(
      f.requests.every((request) => request.reasoning === 'high' && request.transport === 'sse')
    ).toBe(true);
    expect(f.notices).toEqual([
      {
        key: keys[0],
        previous: undefined,
        scope: { settingsProviderId: 'pool', modelId: config.modelId },
      },
      {
        key: keys[1],
        previous: keys[0],
        scope: { settingsProviderId: 'pool', modelId: config.modelId },
      },
    ]);
  });
  it.each(['auth', 'stream-quota'] as const)(
    '%s结构化失败可接替，正常429不可接替',
    async (reply) => {
      const f = await fixture([reply, 'ok']);
      const session = await f.create();
      await session.prompt('task');
      expect(f.requests.map((request) => request.key)).toEqual(keys);
      expect(f.failures).toHaveLength(1);
    }
  );
  it('普通429不伪判硬额度，固定模式不强制SSE、不接替', async () => {
    const f = await fixture(['rate']);
    const session = await f.create();
    await session.prompt('task');
    expect(f.requests).toHaveLength(1);
    expect(f.failures).toHaveLength(0);
    const fixed = f.runtime.getModel(keys[0], config.modelId);
    if (!fixed) throw new Error('missing');
    const fixedSession = await f.create(fixed);
    await fixedSession.prompt('fixed');
    expect(f.requests.at(-1)?.transport).not.toBe('sse');
  });
  it('父子SDK会话共用Main池游标并各自只结算一次，池耗尽有终态', async () => {
    const f = await fixture(['quota', 'quota']);
    const parent = await f.create();
    const child = await f.create();
    let childSettled = 0;
    child.subscribe((event) => {
      if (event.type === 'agent_settled') childSettled++;
    });
    await child.prompt('child task');
    expect(childSettled).toBe(1);
    expect((child.messages.at(-1) as AssistantMessage).errorMessage).toContain(
      'No available ChatGPT'
    );
    await parent.prompt('parent task');
    expect(f.requests).toHaveLength(2);
    expect((parent.messages.at(-1) as AssistantMessage).errorMessage).toContain(
      'No available ChatGPT'
    );
  });
  it('父子同时撞上同一耗尽账号，分别续跑下一账号且每个会话仅结算一次', async () => {
    const f = await fixture(['quota', 'quota', 'ok', 'ok']);
    const parent = await f.create();
    const child = await f.create();
    let parentSettled = 0;
    let childSettled = 0;
    parent.subscribe((event) => {
      if (event.type === 'agent_settled') parentSettled++;
    });
    child.subscribe((event) => {
      if (event.type === 'agent_settled') childSettled++;
    });
    await Promise.all([parent.prompt('parent task'), child.prompt('child task')]);
    expect(f.requests.map((request) => request.key)).toEqual([keys[0], keys[0], keys[1], keys[1]]);
    expect(parentSettled).toBe(1);
    expect(childSettled).toBe(1);
    expect((parent.messages.at(-1) as AssistantMessage).stopReason).toBe('stop');
    expect((child.messages.at(-1) as AssistantMessage).stopReason).toBe('stop');
  });
  it('结算前等待选号时取消，延迟成功不得复活或发第二次请求', async () => {
    let unblock: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const select: OauthPoolSelector = async (_id, _model, failed) => {
      if (!failed) return keys[0];
      entered?.();
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
      return keys[1];
    };
    const f = await fixture(['quota', 'ok'], select);
    const session = await f.create();
    const prompt = session.prompt('task');
    await waiting;
    const abort = session.abort();
    unblock?.();
    await Promise.all([prompt, abort]);
    expect(f.requests).toHaveLength(1);
    expect(session.isStreaming).toBe(false);
  });
});
