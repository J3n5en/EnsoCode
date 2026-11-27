// 压缩 / 分支摘要不能进 agy：agy 自己管上下文，pi 的「总结这段对话」发进去会污染 agy 会话、白烧额度。
// 真 pi AgentSession + 假 agy CLI（fixtures/fakeAgy.mjs）：断言 agy 实际收到了哪些 session/prompt。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AssistantMessage, isContextOverflow } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { AGY_PROVIDER_ID } from '@shared/agy/constants';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApprovalGate } from '../approval';
import { continuousMemoryInlineExtension } from '../continuousMemory/extension';
import { takeCompactCancel } from '../ensoCompact/cancel';
import { smartCompactInlineExtension } from '../smartCompact';
import { agyCompactGuardExtension, withAgyCompactGuard } from './compactGuard';
import { closeHostMcp } from './hostMcp';
import { registerAgyProvider, streamAgy } from './provider';
import { closeAllAgySessions } from './registry';
import { setAgySessionOpener } from './runtimeHost';
import { openAgySession } from './session';
import { attachAgyBridgeToSession } from './sessionBridge';
import { setAgyWorkerConfig } from './workerConfig';

const fakeCli = fileURLToPath(new URL('./fixtures/fakeAgy.mjs', import.meta.url));
const other = getModel('openai', 'gpt-4o-mini');
if (!other) throw new Error('Test model is not available in the bundled Pi catalog.');

const cleanups: Array<() => void> = [];
beforeEach(() => {
  setAgyWorkerConfig({ binaryPath: process.execPath, skipPermissions: false, models: [] });
});
afterEach(async () => {
  setAgySessionOpener(undefined);
  setAgyWorkerConfig({ binaryPath: '', skipPermissions: false, models: [] });
  await closeAllAgySessions();
  await closeHostMcp();
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function summaryReply(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: other!.api,
    provider: other!.provider,
    model: other!.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

interface SetupOptions {
  extensions?: InlineExtension[];
  /** 打开 pi 自动压缩，并把阈值压到第一轮就触发（reserveTokens 缺省 990k） */
  autoCompact?: boolean;
  reserveTokens?: number;
  env?: Record<string, string>;
}

async function setup(name: string, options: SetupOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'agy-compact-'));
  const cwd = path.join(root, 'workspace');
  const agentDir = path.join(root, 'agent');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const log = path.join(root, 'agy.log');
  setAgySessionOpener((opener) =>
    openAgySession({
      ...opener,
      command: process.execPath,
      args: [fakeCli],
      env: { ...process.env, FAKE_AGY_LOG: log, ...options.env },
      timeoutMs: 8_000,
    })
  );
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  registerAgyProvider(runtime, []);
  vi.spyOn(runtime, 'hasConfiguredAuth').mockReturnValue(true);
  const otherCalls: string[] = [];
  const fakeOther = (model: { id: string }) => {
    otherCalls.push(model.id);
    const stream = createAssistantMessageEventStream();
    const message = summaryReply('SUMMARY-FROM-OTHER-MODEL');
    stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  };
  vi.spyOn(runtime, 'streamSimple').mockImplementation((model, context, streamOptions) => {
    if (model.provider === AGY_PROVIDER_ID) {
      return streamAgy(model as never, context as never, streamOptions as never) as never;
    }
    return fakeOther(model);
  });
  // ctx.modelRegistry.complete 走 runtime.stream：agy 照常进 provider，其他模型给假摘要
  const stream = runtime.stream.bind(runtime);
  vi.spyOn(runtime, 'stream').mockImplementation((model, context, streamOptions) =>
    model.provider === AGY_PROVIDER_ID
      ? stream(model, context, streamOptions)
      : (fakeOther(model) as never)
  );
  const agyModel = runtime.getModel(AGY_PROVIDER_ID, 'default');
  if (!agyModel) throw new Error('agy model missing');
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'agy compaction test',
    ...(options.extensions ? { extensionFactories: options.extensions } : {}),
  });
  await resourceLoader.reload();
  const manager = SessionManager.create(cwd, path.join(root, 'sessions'));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: agyModel,
    thinkingLevel: 'off',
    resourceLoader,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: options.autoCompact
        ? { enabled: true, reserveTokens: options.reserveTokens ?? 990_000, keepRecentTokens: 1 }
        : { enabled: false, keepRecentTokens: 1 },
    }),
    noTools: 'builtin',
  });
  attachAgyBridgeToSession(session, {
    ensoSessionId: name,
    cwd,
    sessionDir: path.join(root, 'sessions'),
    clientVersion: '0.0.0',
    gate: new ApprovalGate(
      'full',
      () => {},
      () => {}
    ),
    planActive: () => false,
    readRoots: () => [cwd],
  });
  cleanups.push(() => {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  /** agy 收到的每个 session/prompt 的正文（假 CLI 收到时、处理时各记一条，取处理那条） */
  const prompts = () => {
    if (!existsSync(log)) return [];
    const rows = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: { prompt?: unknown } })
      .filter((row) => row.method === 'session/prompt');
    return rows
      .filter((_, index) => index % 2 === 1)
      .map((row) =>
        (Array.isArray(row.params?.prompt) ? row.params.prompt : [])
          .map((part: { text?: string }) => part.text ?? '')
          .join('')
      );
  };
  const compactions = () => manager.getEntries().filter((entry) => entry.type === 'compaction');
  const starts: string[] = [];
  const ends: Array<{ reason: string; aborted: boolean; errorMessage?: string }> = [];
  session.subscribe((event) => {
    if (event.type === 'compaction_start') starts.push(event.reason);
    if (event.type === 'compaction_end') ends.push(event);
  });
  return { session, manager, prompts, compactions, otherCalls, starts, ends };
}

async function chat(session: Awaited<ReturnType<typeof setup>>['session'], texts: string[]) {
  for (const text of texts) await session.prompt(text);
}

const sessionModelRoute = { summaryModel: undefined, mode: 'fast' as const };
/** supervisor 在 standard 策略（没有 Enso 压缩扩展）时挂的那个 */
const standard = [agyCompactGuardExtension];

function summaryOf(entry: unknown): string {
  return entry && typeof entry === 'object' && 'summary' in entry ? String(entry.summary) : '';
}

it('refuses compaction requests at the bridge even when no Enso handler takes them', async () => {
  const { session, prompts, compactions } = await setup('enso-native-manual');
  await chat(session, ['first', 'second']);
  expect(prompts()).toHaveLength(2);
  await expect(session.compact()).rejects.toThrow(/agy only serves chat turns/);
  expect(prompts()).toHaveLength(2);
  expect(compactions()).toEqual([]);
  await chat(session, ['third']);
  expect(prompts()).toEqual([expect.stringContaining('first'), 'second', 'third']);
}, 30_000);

it('standard strategy: manual compaction is local, persisted, and the session keeps working', async () => {
  const { session, prompts, compactions } = await setup('enso-standard-manual', {
    extensions: standard,
  });
  await chat(session, ['first', 'second']);
  const result = await session.compact();
  expect(prompts()).toHaveLength(2);
  expect(compactions()).toHaveLength(1);
  expect(result.summary).toContain('## Progress');
  expect(summaryOf(compactions()[0])).toBe(result.summary);
  await chat(session, ['third']);
  expect(prompts()).toEqual([expect.stringContaining('first'), 'second', 'third']);
}, 30_000);

it('a turn whose model calls sum past the window is not a context overflow', async () => {
  // 真实会话：一轮里 agy 内部多次调用，PromptResponse.usage 累加到 5.3M；usage_update.used 才是上下文
  const { session, prompts, starts } = await setup('enso-aggregate', {
    autoCompact: true,
    reserveTokens: 16_384,
    extensions: standard,
    env: { FAKE_AGY_INPUT_TOKENS: '5357142', FAKE_AGY_CONTEXT_USED: '30000' },
  });
  await chat(session, ['first', 'second']);
  await session.waitForIdle();
  const last = session.messages.filter((message) => message.role === 'assistant').at(-1);
  expect(last?.role).toBe('assistant');
  const assistant = last as AssistantMessage;
  expect(assistant.usage).toMatchObject({ input: 30_000, cacheRead: 0, totalTokens: 30_000 });
  expect(isContextOverflow(assistant, 1_000_000)).toBe(false);
  expect(starts).toEqual([]);
  expect(prompts()).toHaveLength(2);
}, 30_000);

it('agy sessions run no automatic compaction: a context past the threshold starts none', async () => {
  // agy 自己管上下文，Enso 只把最后一条 user 发过去：压 Enso 的记录对 agy 没有任何作用
  const { session, prompts, compactions, starts } = await setup('enso-standard-auto', {
    autoCompact: true,
    extensions: standard,
    env: { FAKE_AGY_INPUT_TOKENS: '50000', FAKE_AGY_CONTEXT_USED: '50000' },
  });
  await chat(session, ['first', 'second', 'third']);
  await session.waitForIdle();
  expect(starts).toEqual([]);
  expect(compactions()).toEqual([]);
  expect(prompts()).toEqual([expect.stringContaining('first'), 'second', 'third']);
  // 手动压缩照常可用，且是本地摘要
  const result = await session.compact();
  expect(result.summary).toContain('## Progress');
  expect(prompts()).toHaveLength(3);
}, 30_000);

// 真实故障的形状：会话只有一轮（agy 一轮里跑了几十个工具），切点落在这一轮中间，
// messagesToSummarize 为空、全在 turnPrefixMessages 里。Enso 的处理器裁不出东西返回 undefined，
// pi 退回原生「turn prefix」摘要，发给 agy 被桥拒绝，用户看到「压缩失败」。
const giveUpStrategies: Array<[string, () => InlineExtension]> = [
  [
    'continuous-memory',
    () =>
      withAgyCompactGuard(continuousMemoryInlineExtension({ compact: { ...sessionModelRoute } })),
  ],
  [
    'smart',
    () => withAgyCompactGuard(smartCompactInlineExtension(null, false, { ...sessionModelRoute })),
  ],
  [
    'smart with a summary model',
    () =>
      withAgyCompactGuard(
        smartCompactInlineExtension(null, false, {
          mode: 'fast',
          summaryModel: { provider: other.provider, id: other.id },
        })
      ),
  ],
];

for (const [name, extension] of giveUpStrategies) {
  it(`${name} strategy: a compaction the Enso handler gives up on never reaches agy, and fails silently`, async () => {
    const { session, manager, prompts, compactions, ends } = await setup(`enso-giveup-${name}`, {
      extensions: [extension()],
    });
    await chat(session, ['one long turn']);
    expect(prompts()).toHaveLength(1);
    // 溢出恢复那条路（真实故障）：pi 不重试，压不了就安静取消
    const overflow = (
      session as unknown as { _runAutoCompaction: (r: string, w: boolean) => Promise<boolean> }
    )._runAutoCompaction('overflow', false);
    await expect(overflow).resolves.toBe(false);
    // 手动压缩同样不进 agy；取消不带错误文案
    const manual = await session.compact().then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    expect(manual ?? '').not.toMatch(/agy only serves|summarization failed/);
    expect(prompts()).toHaveLength(1);
    expect(compactions()).toEqual([]);
    expect(ends.length).toBe(2);
    for (const end of ends) {
      expect(end.errorMessage).toBeUndefined();
      expect(end.aborted).toBe(true);
    }
    // supervisor 把钩子留下的取消原因当错误弹 toast：这里不能留
    expect(takeCompactCancel(manager)).toBeUndefined();
    await chat(session, ['next']);
    expect(prompts()).toHaveLength(2);
  }, 30_000);
}

it('smart strategy without a summary model: manual compaction stays local', async () => {
  const { session, prompts, compactions, otherCalls } = await setup('enso-smart-manual', {
    extensions: [smartCompactInlineExtension(null, false, { ...sessionModelRoute })],
  });
  await chat(session, ['first', 'second']);
  await session.compact();
  expect(prompts()).toHaveLength(2);
  expect(otherCalls).toEqual([]);
  expect(compactions()).toHaveLength(1);
  // 不试 agy 再降级：直接确定性兜底，不留「模型摘要不可用」的分块注记
  expect(summaryOf(compactions()[0])).not.toContain('model summary unavailable');
}, 30_000);

it('smart strategy with a non-agy summary model: uses that model, not agy', async () => {
  const { session, prompts, compactions, otherCalls } = await setup('enso-smart-summary', {
    extensions: [
      smartCompactInlineExtension(null, false, {
        mode: 'fast',
        summaryModel: { provider: other.provider, id: other.id },
      }),
    ],
  });
  await chat(session, ['first', 'second']);
  await session.compact();
  expect(prompts()).toHaveLength(2);
  expect(otherCalls.length).toBeGreaterThan(0);
  expect(summaryOf(compactions()[0])).toContain('SUMMARY-FROM-OTHER-MODEL');
}, 30_000);

it('continuous-memory strategy: manual compaction stays local', async () => {
  const { session, prompts, compactions } = await setup('enso-memory-manual', {
    extensions: [continuousMemoryInlineExtension({ compact: { ...sessionModelRoute } })],
  });
  await chat(session, ['first', 'second']);
  await session.compact();
  expect(prompts()).toHaveLength(2);
  expect(compactions()).toHaveLength(1);
}, 30_000);

it('branch summary on tree navigation never prompts agy', async () => {
  const { session, manager, prompts } = await setup('enso-branch', { extensions: standard });
  await chat(session, ['first']);
  const firstUser = manager
    .getEntries()
    .find((entry) => entry.type === 'message' && entry.message.role === 'user');
  await chat(session, ['second']);
  expect(prompts()).toHaveLength(2);
  await session.navigateTree(firstUser!.id, { summarize: true }).catch(() => undefined);
  expect(prompts()).toHaveLength(2);
}, 30_000);

it('bug-report summary never prompts agy', async () => {
  const { session, prompts } = await setup('enso-bug', { extensions: standard });
  await chat(session, ['first']);
  await expect(
    session.summarizeForBugReport({ signal: new AbortController().signal })
  ).rejects.toThrow(/agy only serves chat turns/);
  expect(prompts()).toHaveLength(1);
}, 30_000);

it('still serves continue through the bridge', async () => {
  const { session, prompts } = await setup('enso-continue', { extensions: standard });
  await chat(session, ['first']);
  // pi 的重试和溢出后续跑都走 agent.continue()
  session.agent.state.messages = [
    ...session.agent.state.messages,
    { role: 'user', content: [{ type: 'text', text: 'go on' }], timestamp: Date.now() },
  ];
  await session.agent.continue();
  expect(prompts()).toHaveLength(2);
}, 30_000);
