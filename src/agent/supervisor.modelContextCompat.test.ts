import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context, Model } from '@earendil-works/pi-ai';
import { hasApi, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { SpawnModelConfig } from '@shared/types';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ContextMessage, sanitizeContextMessages } from './imageContext';
import { initializeWorkerRuntime, resolveBaseModel } from './supervisor';
import { registerVirtualModel } from './virtualModels';

// initializeWorkerRuntime 会装载 cursor provider（读磁盘配置）；测试只要真实 ModelRuntime，
// 不碰真实凭据，所以按 supervisor.test.ts 的方式替换掉 loader。
vi.mock('./cursor/loadProvider', () => ({
  CURSOR_PROVIDER_ID: 'cursor',
  loadCursorProvider: vi.fn().mockResolvedValue(undefined),
}));

const REPLY = 'fixture reply: read a.ts.';
const THINKING_SIGNATURE = JSON.stringify({
  id: 'rs_fixture_1',
  type: 'reasoning',
  summary: [],
});
const CALL_ID = 'call_fixture_1';

/**
 * 真实故障：signed thinking + toolCall、没有 text 的 assistant 历史
 * - 补 `text: ''` 后 Kimi 的 Responses 网关 400（`$.input[2].content[0].text` 不能是空串）；
 * - xAI 的 openai-responses 恰恰需要一个空 message 项，否则 reasoning 后的 function_call 重放失败。
 * 所以同一段上下文在两种物理模型出口上的 wire 形态必须不同。
 */
const GROK_CONFIG = {
  api: 'openai-responses' as const,
  baseUrl: 'https://api.x.ai/v1',
  apiKey: 'sk-fixture-grok-not-a-real-secret',
  modelId: 'grok-4.7',
  settingsProviderId: 'model-context-compat-grok',
  contextWindow: 256_000,
  maxTokens: 32_000,
};

const KIMI_CONFIG: SpawnModelConfig = {
  ...GROK_CONFIG,
  baseUrl: 'https://api.moonshot.cn/v1',
  apiKey: 'sk-fixture-kimi-not-a-real-secret',
  modelId: 'kimi-k2-thinking',
  settingsProviderId: 'model-context-compat-kimi',
};

type WireItem = Record<string, unknown>;

function inputItems(body: Record<string, unknown>): WireItem[] {
  return Array.isArray(body.input) ? (body.input as WireItem[]) : [];
}

/** wire 上所有 assistant message 项的 output_text 文本（空串就是 Kimi 400 的直接原因） */
function assistantTextParts(body: Record<string, unknown>): string[] {
  const texts: string[] = [];
  for (const item of inputItems(body)) {
    if (item.type !== 'message' || item.role !== 'assistant') continue;
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content as WireItem[]) {
      if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
    }
  }
  return texts;
}

function emptyAssistantTextCount(body: Record<string, unknown>): number {
  return assistantTextParts(body).filter((textValue) => textValue.trim() === '').length;
}

function itemIds(body: Record<string, unknown>, type: string): unknown[] {
  return inputItems(body)
    .filter((item) => item.type === type)
    .map((item) => item.call_id);
}

function reasoningItemIds(body: Record<string, unknown>): unknown[] {
  return inputItems(body)
    .filter((item) => item.type === 'reasoning')
    .map((item) => item.id);
}

/** 真实 400 发生在 toolResult 之后的续轮：请求的最后一项必须是 function_call_output */
function lastInputType(body: Record<string, unknown>): unknown {
  const items = inputItems(body);
  return items[items.length - 1]?.type;
}

/** 原始（未清洗）历史：signed thinking + toolCall，没有 text 块 */
function toolHistory(model: Model<'openai-responses'>): ContextMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'read a.ts' }], timestamp: 1 },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'need the file', thinkingSignature: THINKING_SIGNATURE },
        { type: 'toolCall', id: CALL_ID, name: 'read', arguments: { path: 'a.ts' } },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: 2,
    },
    {
      role: 'toolResult',
      toolCallId: CALL_ID,
      toolName: 'read',
      content: [{ type: 'text', text: 'const a = 1;' }],
      isError: false,
      timestamp: 3,
    },
  ];
}

const READ_TOOL = {
  name: 'read',
  description: 'Read a fixture file.',
  parameters: Type.Object({ path: Type.String() }),
};

function contextOf(messages: ContextMessage[]): Context {
  return { messages: messages as unknown as Context['messages'], tools: [READ_TOOL] };
}

/** 只伪造最终传输：Pi 必须自己解析真实 Responses 事件 */
function responsesSse(modelId: string): Response {
  const part = { type: 'output_text', text: REPLY, annotations: [] };
  const item = {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [part],
  };
  const response = {
    id: 'resp_fixture',
    object: 'response',
    created_at: 1,
    model: modelId,
    status: 'completed',
    output: [item],
    usage: {
      input_tokens: 40,
      output_tokens: 8,
      total_tokens: 48,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const position = { item_id: item.id, output_index: 0, content_index: 0 };
  const events = [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [], usage: null },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    { type: 'response.content_part.added', ...position, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', ...position, delta: REPLY },
    { type: 'response.output_text.done', ...position, text: REPLY },
    { type: 'response.content_part.done', ...position, part },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  return new Response(
    events
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`
      )
      .join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}

describe('模型出口的上下文兼容（真实 Responses serializer + fake transport）', () => {
  let runtime: ModelRuntime;
  let grok: Model<'openai-responses'>;
  let kimi: Model<'openai-responses'>;
  let requests: Array<{ body: Record<string, unknown>; url: string }>;
  let tempDir: string | undefined;

  beforeEach(async () => {
    requests = [];
    vi.stubEnv('PI_OFFLINE', '1');
    vi.stubEnv('PI_CACHE_RETENTION', 'short');
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/responses')) {
        // 任何意外的目录/发现请求都必须显式失败，不能静默放过
        throw new Error(`Unexpected fixture request: ${request.method} ${request.url}`);
      }
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({ body, url: request.url });
      return responsesSse(String(body.model));
    };
    vi.stubGlobal('fetch', fakeFetch);
    // 临时目录 + 内存凭据：不读开发机真实 settings/auth.json
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-model-context-'));
    tempDir = dir;
    runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      authPath: path.join(dir, 'auth.json'),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    // 应用里的正常顺序：getRuntime → initializeWorkerRuntime → resolve 模型 → 发请求
    await initializeWorkerRuntime(runtime);
    const resolvedGrok = resolveBaseModel(runtime, GROK_CONFIG);
    if (!hasApi(resolvedGrok, 'openai-responses')) throw new Error('Expected Grok fixture model');
    grok = resolvedGrok;
    const resolvedKimi = resolveBaseModel(runtime, KIMI_CONFIG);
    if (!hasApi(resolvedKimi, 'openai-responses')) throw new Error('Expected Kimi fixture model');
    kimi = resolvedKimi;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    // 只清本 describe 自己创建的临时目录
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('自检：fixture 的 SSE 能被真实 Responses 解析器收成终态回复', async () => {
    const result = await runtime
      .streamSimple(kimi, contextOf([{ role: 'user', content: 'hi', timestamp: 1 }]))
      .result();
    expect(result.stopReason, result.errorMessage).toBe('stop');
    expect(result.content).toMatchObject([{ type: 'text', text: REPLY }]);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.model).toBe(KIMI_CONFIG.modelId);
  });

  // 根因回归：通用清洗若无差别补 text:''，Kimi 的 Responses 网关下一轮 400
  // `$.input[2].content[0].text` 为空串。
  it('Kimi 走完整 sanitize 后 wire 上不得出现空 output_text', async () => {
    const raw = toolHistory(kimi);
    const cleaned = sanitizeContextMessages(raw);
    const result = await runtime.stream(kimi, contextOf(cleaned)).result();
    expect(result.stopReason, result.errorMessage).toBe('stop');
    const body = requests.at(-1)?.body ?? {};
    expect(body.model).toBe(KIMI_CONFIG.modelId);
    expect(assistantTextParts(body)).toEqual([]);
    expect(emptyAssistantTextCount(body)).toBe(0);
    // 清洗不能破坏重放：签名与工具配对原样保留
    const cleanedContent = (cleaned[1]?.content ?? []) as unknown[];
    expect(cleanedContent[1]).toMatchObject({ type: 'toolCall', id: CALL_ID });
    expect(reasoningItemIds(body)).toEqual(['rs_fixture_1']);
    expect(itemIds(body, 'function_call')).toEqual([CALL_ID]);
    expect(itemIds(body, 'function_call_output')).toEqual([CALL_ID]);
    expect(lastInputType(body)).toBe('function_call_output');
  });

  // 反向契约：xAI 的 openai-responses 需要 reasoning 之后那个空 message 项，
  // 现在只有模型出口能补，历史本身必须保持干净（不靠 sanitize 补空）。
  it('Grok 的干净历史经已 initialize 的 runtime 出口仍保留 xAI 空 message 兼容', async () => {
    const historyMessages = toolHistory(grok);
    // 四种出口面（raw/simple × stream/complete）必须产生同构的 wire 形态
    const sends: Array<{
      surface: string;
      run: () => Promise<{ stopReason: string; errorMessage?: string }>;
    }> = [
      { surface: 'stream', run: () => runtime.stream(grok, contextOf(historyMessages)).result() },
      {
        surface: 'streamSimple',
        run: () => runtime.streamSimple(grok, contextOf(historyMessages)).result(),
      },
      { surface: 'complete', run: () => runtime.complete(grok, contextOf(historyMessages)) },
      {
        surface: 'completeSimple',
        run: () => runtime.completeSimple(grok, contextOf(historyMessages)),
      },
    ];
    for (const { surface, run } of sends) {
      const result = await run();
      expect(result.stopReason, `${surface}: ${result.errorMessage}`).toBe('stop');
    }
    expect(requests).toHaveLength(4);
    const bodies = requests.map((entry) => entry.body);
    const historyContent = (historyMessages[1]?.content ?? []) as unknown[];
    for (const body of bodies) {
      expect(body.model).toBe(GROK_CONFIG.modelId);
      // 补空只能发生在 wire 副本上，不能改写历史
      expect(historyContent.length).toBe(2);
      expect(reasoningItemIds(body)).toEqual(['rs_fixture_1']);
      expect(itemIds(body, 'function_call')).toEqual([CALL_ID]);
      expect(itemIds(body, 'function_call_output')).toEqual([CALL_ID]);
      expect(lastInputType(body)).toBe('function_call_output');
    }
    expect(
      bodies.filter((body) => emptyAssistantTextCount(body) > 0).length,
      `wire assistant texts: ${JSON.stringify(bodies.map((body) => assistantTextParts(body)))}`
    ).toBeGreaterThan(0);
  });

  // 虚拟模型名不能参与判定：route 到的物理模型才是出口形态的依据。
  it('虚拟模型 route 到 Kimi 不补空、route 到 Grok 补空，工具配对都完整', async () => {
    const virtualConfig = (
      modelId: string,
      primary: SpawnModelConfig,
      fast: SpawnModelConfig
    ): SpawnModelConfig => ({
      // 顶层字段只作占位，成员由 virtual 决定（与 spawn 下发的形态一致）
      api: 'openai-responses',
      baseUrl: '',
      apiKey: '',
      modelId,
      settingsProviderId: 'enso-virtual',
      virtual: { name: modelId, primary, fast, fallbacks: [] },
    });
    const resolveMember = async (config: SpawnModelConfig) => resolveBaseModel(runtime, config);

    // streamSimple 的直接调用走 fast ?? primary：用 fast 指定 route 目标，primary 指向对手
    const toKimi = await registerVirtualModel(
      runtime,
      virtualConfig('virtual-to-kimi', GROK_CONFIG, KIMI_CONFIG),
      resolveMember
    );
    const toGrok = await registerVirtualModel(
      runtime,
      virtualConfig('virtual-to-grok', KIMI_CONFIG, GROK_CONFIG),
      resolveMember
    );

    const kimiResult = await runtime
      .streamSimple(toKimi.model, contextOf(toolHistory(kimi)))
      .result();
    expect(kimiResult.stopReason, kimiResult.errorMessage).toBe('stop');
    const kimiBody = requests.at(-1)?.body ?? {};
    expect(kimiBody.model).toBe(KIMI_CONFIG.modelId);
    expect(emptyAssistantTextCount(kimiBody)).toBe(0);
    expect(itemIds(kimiBody, 'function_call')).toEqual([CALL_ID]);
    expect(itemIds(kimiBody, 'function_call_output')).toEqual([CALL_ID]);
    expect(lastInputType(kimiBody)).toBe('function_call_output');

    const grokResult = await runtime
      .streamSimple(toGrok.model, contextOf(toolHistory(grok)))
      .result();
    expect(grokResult.stopReason, grokResult.errorMessage).toBe('stop');
    const grokBody = requests.at(-1)?.body ?? {};
    expect(grokBody.model).toBe(GROK_CONFIG.modelId);
    expect(emptyAssistantTextCount(grokBody)).toBeGreaterThan(0);
    expect(itemIds(grokBody, 'function_call')).toEqual([CALL_ID]);
    expect(itemIds(grokBody, 'function_call_output')).toEqual([CALL_ID]);
    expect(lastInputType(grokBody)).toBe('function_call_output');
  });
});
