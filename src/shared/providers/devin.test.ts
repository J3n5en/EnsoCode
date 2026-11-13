import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { normalizeContext } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
  buildDevinAuthUrl,
  DEVIN_API_ID,
  DEVIN_PROVIDER_ID,
  devinProviderConfig,
  exchangeDevinCliToken,
  generateDevinPkce,
  getDevinTokenExpiry,
  normalizeDevinModels,
  normalizeDevinSessionToken,
} from './devin';
import {
  ChatMessageSource,
  create,
  fromBinary,
  type GetChatMessageRequest,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  GetUserJwtResponseSchema,
  StopReason,
  toBinary,
} from './devin/proto';

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
}

function connectFrame(flag: number, payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flag;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

describe('Devin CLI 登录', () => {
  it('PKCE challenge 是 verifier 的 SHA-256 base64url', () => {
    const pkce = generateDevinPkce();
    expect(pkce.verifier.length).toBeGreaterThan(32);
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
  });

  it('授权地址带 redirect / state / PKCE', () => {
    const url = buildDevinAuthUrl('state-1', 'http://127.0.0.1:59653/callback', 'challenge-1');
    expect(url.startsWith('https://app.devin.ai/auth/cli/continue?')).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('redirect_uri')).toBe('http://127.0.0.1:59653/callback');
    expect(params.get('state')).toBe('state-1');
    expect(params.get('prompt')).toBe('select_account');
    expect(params.get('code_challenge')).toBe('challenge-1');
    expect(params.get('code_challenge_method')).toBe('S256');
  });

  it('用回调 code 换 CLI token', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const token = await exchangeDevinCliToken(
      'callback-code',
      'pkce-verifier',
      async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return new Response(JSON.stringify({ token: 'devin-jwt' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    );
    expect(token).toBe('devin-jwt');
    expect(requestUrl).toBe('https://api.devin.ai/auth/cli/token');
    expect(requestInit?.method).toBe('POST');
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      code: 'callback-code',
      code_verifier: 'pkce-verifier',
    });
  });

  it('换 token 失败或空 token 都拒绝', async () => {
    await expect(
      exchangeDevinCliToken('x', 'y', async () => new Response('nope', { status: 401 }))
    ).rejects.toThrow(/401/);
    await expect(
      exchangeDevinCliToken(
        'x',
        'y',
        async () => new Response(JSON.stringify({ token: '' }), { status: 200 })
      )
    ).rejects.toThrow(/empty token/i);
  });

  it('JWT exp 预扣 5 分钟；非 JWT 退 1 年', () => {
    const now = 1_700_000_000_000;
    expect(getDevinTokenExpiry(fakeJwt({ exp: 1_700_000_000 + 3600 }), now)).toBe(
      now + 3_600_000 - 5 * 60 * 1000
    );
    expect(getDevinTokenExpiry('not-a-jwt', now)).toBe(now + 365 * 24 * 60 * 60 * 1000);
  });
});

describe('Devin session token 与模型发现', () => {
  it('没有前缀时补上 devin-session-token$', () => {
    expect(normalizeDevinSessionToken('abc')).toBe('devin-session-token$abc');
    expect(normalizeDevinSessionToken('devin-session-token$abc')).toBe('devin-session-token$abc');
  });

  it('跳过 disabled / 空 uid，按思考标签与 features 标 reasoning', () => {
    const models = normalizeDevinModels([
      {
        label: 'GPT Fast',
        modelUid: 'gpt-fast',
        disabled: false,
        supportsImages: true,
        maxTokens: 128_000,
        modelInfo: { modelFeatures: { supportsThinking: false } },
      },
      {
        label: 'Claude Thinking',
        modelUid: 'claude-think',
        disabled: false,
        supportsImages: false,
        maxTokens: 0,
      },
      { label: 'off', modelUid: 'x', disabled: true, supportsImages: false, maxTokens: 1 },
      { label: 'empty', modelUid: '  ', disabled: false, supportsImages: false, maxTokens: 1 },
    ]);
    expect(models.map((model) => model.id)).toEqual(['claude-think', 'gpt-fast']);
    expect(models[0]).toMatchObject({
      id: 'claude-think',
      name: 'Claude Thinking',
      reasoning: true,
      input: ['text'],
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
    expect(models[1]).toMatchObject({
      id: 'gpt-fast',
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: 128_000,
    });
  });
});

describe('Devin provider 注册', () => {
  it('以订阅 OAuth provider 暴露 login / stream', () => {
    const config = devinProviderConfig();
    expect(DEVIN_PROVIDER_ID).toBe('devin');
    expect(config.api).toBe(DEVIN_API_ID);
    expect(config.oauth?.isSubscription).toBe(true);
    expect(config.oauth?.name).toBe('Devin');
    expect(typeof config.oauth?.login).toBe('function');
    expect(typeof config.streamSimple).toBe('function');
    expect(typeof config.refreshModels).toBe('function');
    expect(config.oauth?.getApiKey({ access: 'tok', refresh: 'tok', expires: 1 })).toBe('tok');
  });
});

describe('Devin streamSimple（假 fetch）', () => {
  const model = {
    id: 'claude-think',
    name: 'Claude Thinking',
    api: DEVIN_API_ID,
    provider: DEVIN_PROVIDER_ID,
    baseUrl: 'https://server.codeium.com',
    reasoning: true,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  };

  it('把 thinking / text / toolCall 翻成 pi 事件，stopReason 抬成 toolUse', async () => {
    const thinking = create(GetChatMessageResponseSchema, {
      deltaThinking: '想一下',
      deltaSignature: 'sig',
    });
    const text = create(GetChatMessageResponseSchema, { messageId: 'bot-1', deltaText: '你好' });
    const tool = create(GetChatMessageResponseSchema, {
      deltaToolCalls: [{ id: 'call_1', name: 'read', argumentsJson: '{"path":"a.ts"}' }],
      usage: {
        inputTokens: 10n,
        outputTokens: 4n,
        cacheReadTokens: 2n,
        cacheWriteTokens: 1n,
      },
      stopReason: StopReason.UNSPECIFIED,
    });
    const body = Buffer.concat([
      connectFrame(0, toBinary(GetChatMessageResponseSchema, thinking)),
      connectFrame(0, toBinary(GetChatMessageResponseSchema, text)),
      connectFrame(0, toBinary(GetChatMessageResponseSchema, tool)),
    ]);
    const jwt = toBinary(
      GetUserJwtResponseSchema,
      create(GetUserJwtResponseSchema, { userJwt: 'user-jwt' })
    );

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('GetUserJwt')) {
        return new Response(Buffer.from(jwt), { status: 200 });
      }
      expect(url).toContain('GetChatMessage');
      expect(init?.headers).toMatchObject({ 'content-type': 'application/connect+proto' });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const stream = devinProviderConfig().streamSimple?.(
      model,
      normalizeContext({
        systemPrompt: 'sys',
        messages: [
          { role: 'user', content: 'hi', timestamp: 0 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'prev' }],
            api: DEVIN_API_ID,
            provider: DEVIN_PROVIDER_ID,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            timestamp: 1,
          },
        ],
        tools: [{ name: 'read', description: '读文件', parameters: { type: 'object' } as never }],
      }),
      { apiKey: 'session-token', fetch: fetchImpl }
    );
    if (!stream) throw new Error('streamSimple 未注册');

    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    const message = await stream.result();
    expect(types).toEqual([
      'start',
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_end',
      'toolcall_start',
      'toolcall_delta',
      'toolcall_end',
      'done',
    ]);
    expect(message.stopReason).toBe('toolUse');
    expect(message.content).toEqual([
      { type: 'thinking', thinking: '想一下', thinkingSignature: 'sig' },
      { type: 'text', text: '你好' },
      { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.ts' } },
    ]);
    expect(message.usage).toMatchObject({
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
    });
    expect(ChatMessageSource.USER).toBe(1);
  });

  // 用户中途停止的 aborted 轮带着从未执行的 toolCall 落盘；Enso 的 dropUnpairedToolResults 按
  // pi transformMessages「error/aborted 整轮跳过」删掉其结果，这里照常回放就是一条没有结果的工具调用
  it('error / aborted 的 assistant 轮不进 chatMessagePrompts', async () => {
    const jwt = toBinary(
      GetUserJwtResponseSchema,
      create(GetUserJwtResponseSchema, { userJwt: 'user-jwt' })
    );
    let sent: GetChatMessageRequest | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('GetUserJwt')) return new Response(Buffer.from(jwt));
      // Connect 帧：1 字节 flag + 4 字节长度，之后是 gzip 过的请求 protobuf
      const frame = Buffer.from(init?.body as Uint8Array);
      sent = fromBinary(GetChatMessageRequestSchema, gunzipSync(frame.subarray(5)));
      return new Response('只取请求体', { status: 500 });
    }) as unknown as typeof fetch;
    const interrupted = (stopReason: 'aborted' | 'error', id: string) => ({
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: 'read', arguments: { path: 'a.ts' } }],
      api: DEVIN_API_ID,
      provider: DEVIN_PROVIDER_ID,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: 1,
    });

    const stream = devinProviderConfig().streamSimple?.(
      model,
      normalizeContext({
        messages: [
          { role: 'user', content: '读一下 a.ts', timestamp: 0 },
          interrupted('aborted', 'call_1'),
          interrupted('error', 'call_2'),
          { role: 'user', content: '继续', timestamp: 2 },
        ] as never,
      }),
      { apiKey: 'session-token', fetch: fetchImpl }
    );
    if (!stream) throw new Error('streamSimple 未注册');
    await stream.result();

    expect(
      sent?.chatMessagePrompts.map((prompt) => ({
        source: prompt.source,
        prompt: prompt.prompt,
        toolCalls: prompt.toolCalls.length,
      }))
    ).toEqual([
      { source: ChatMessageSource.USER, prompt: '读一下 a.ts', toolCalls: 0 },
      { source: ChatMessageSource.USER, prompt: '继续', toolCalls: 0 },
    ]);
  });
});

describe('Devin 额度窗口', () => {
  it('日/周剩余百分比翻成 usedPercent，unix 秒转毫秒', async () => {
    const { parseDevinUsage } = await import('./devin');
    const { GetUserStatusResponseSchema, create } = await import('./devin/proto');
    const probe = parseDevinUsage(
      create(GetUserStatusResponseSchema, {
        userStatus: {
          email: 'devin@example.com',
          planStatus: {
            dailyQuotaRemainingPercent: 25,
            weeklyQuotaRemainingPercent: 80,
            dailyQuotaResetAtUnix: 1_700_000_000n,
            weeklyQuotaResetAtUnix: 1_700_604_800n,
          },
        },
        planInfo: { planName: 'Pro' },
      })
    );
    expect(probe).toEqual({
      email: 'devin@example.com',
      plan: 'Pro',
      windows: [
        { label: 'Daily', usedPercent: 75, resetsAt: 1_700_000_000_000 },
        { label: 'Weekly', usedPercent: 20, resetsAt: 1_700_604_800_000 },
      ],
    });
  });

  it('hide 标记或 0/0 未填充字段不产出窗口；无日周时退到 flex credits', async () => {
    const { parseDevinUsage } = await import('./devin');
    const { GetUserStatusResponseSchema, create } = await import('./devin/proto');
    expect(
      parseDevinUsage(
        create(GetUserStatusResponseSchema, {
          userStatus: {
            planStatus: {
              dailyQuotaRemainingPercent: 40,
              weeklyQuotaRemainingPercent: 10,
              dailyQuotaResetAtUnix: 1n,
              weeklyQuotaResetAtUnix: 2n,
              planInfo: { hideDailyQuota: true, hideWeeklyQuota: true },
            },
          },
        })
      ).windows
    ).toEqual([]);

    expect(parseDevinUsage(create(GetUserStatusResponseSchema, {})).windows).toEqual([]);

    expect(
      parseDevinUsage(
        create(GetUserStatusResponseSchema, {
          userStatus: {
            planStatus: { usedFlexCredits: 30, availableFlexCredits: 70 },
          },
        })
      ).windows
    ).toEqual([{ label: 'credits', usedPercent: 30 }]);
  });

  it('GetUserStatus 带 session token 前缀，失败时空窗口', async () => {
    const { fetchDevinUsage } = await import('./devin');
    const {
      GetUserStatusRequestSchema,
      GetUserStatusResponseSchema,
      create,
      fromBinary,
      toBinary,
    } = await import('./devin/proto');
    const payload = toBinary(
      GetUserStatusResponseSchema,
      create(GetUserStatusResponseSchema, {
        userStatus: {
          email: 'cli@example.com',
          planStatus: {
            dailyQuotaRemainingPercent: 50,
            dailyQuotaResetAtUnix: 1_800_000_000n,
          },
        },
      })
    );
    let requestUrl = '';
    const probe = await fetchDevinUsage({
      apiKey: 'jwt-token',
      fetch: async (url, init) => {
        requestUrl = String(url);
        const body = init?.body;
        const bytes = body instanceof Uint8Array ? body : Buffer.from(String(body ?? ''), 'utf8');
        const decoded = fromBinary(GetUserStatusRequestSchema, new Uint8Array(bytes));
        expect(decoded.metadata?.apiKey).toBe('devin-session-token$jwt-token');
        return new Response(Buffer.from(payload), { status: 200 });
      },
    });
    expect(requestUrl).toBe(
      'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus'
    );
    expect(probe.windows).toEqual([
      { label: 'Daily', usedPercent: 50, resetsAt: 1_800_000_000_000 },
    ]);
    expect(probe.email).toBe('cli@example.com');

    const empty = await fetchDevinUsage({
      apiKey: 'jwt-token',
      fetch: async () => new Response('nope', { status: 401 }),
    });
    expect(empty).toEqual({ windows: [] });
  });
});
