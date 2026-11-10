import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeContext } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';
import { qoderProviderConfig } from './qoder';
import { encodePatRefresh, exchangeJobToken } from './qoder/vendor/auth/pat';
import { getCachedModelConfig, staticCnModels, staticModels } from './qoder/vendor/catalog';
import { qoderDecodeBody } from './qoder/vendor/protocol/encoding';

const dirs: string[] = [];

it('节点日额度耗尽后按当前账号发现可用节点，并拒绝向外域投递凭证', async () => {
  setupDir();
  const config = qoderProviderConfig();
  const routes: Array<{ user: string; host: string }> = [];
  const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url));
    const user = new Headers(init?.headers).get('Cosy-User')!;
    if (target.pathname.endsWith('/region/endpoints')) {
      return new Response(
        JSON.stringify({
          dataNodeMap: {
            remote_agent: ['https://untrusted.example/', `https://${user}.qoder.sh/`],
          },
        })
      );
    }
    routes.push({ user, host: target.hostname });
    return target.hostname === 'api3.qoder.sh'
      ? new Response('{"code":"110","message":"Billing daily count exceeded"}', { status: 403 })
      : new Response('data: [DONE]\n\n');
  });
  const results = await Promise.all(
    ['alice', 'bob'].map(async (userID) => {
      const apiKey = config.oauth!.getApiKey({
        access: `job-${userID}`,
        refresh: '',
        expires: 1,
        userID,
        machineID: `device-${userID}`,
      });
      return config.streamSimple!(staticModels[0], normalizeContext({ messages: [] }), {
        apiKey,
        fetch: send as typeof fetch,
      }).result();
    })
  );
  expect(results.map((r) => r.stopReason)).toEqual(['stop', 'stop']);
  expect(routes).toEqual(
    expect.arrayContaining([
      { user: 'alice', host: 'alice.qoder.sh' },
      { user: 'bob', host: 'bob.qoder.sh' },
    ])
  );
  expect(routes).toHaveLength(4);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setupDir() {
  const dir = mkdtempSync(join(tmpdir(), 'enso-qoder-test-'));
  dirs.push(dir);
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  return dir;
}

it('外部进程新建或更新目录后立即看到模型映射', () => {
  const dir = setupDir();
  const user = 'cache-user';
  const hash = createHash('sha256').update(user).digest('hex');
  const file = join(dir, `qoder-models-cache.json.${hash}`);
  expect(getCachedModelConfig('Fresh', 'global', user)).toBeNull();
  const write = (key: string) =>
    writeFileSync(file, JSON.stringify({ configs: { Fresh: { key, display_name: 'Fresh' } } }));
  write('first');
  expect(getCachedModelConfig('Fresh', 'global', user)?.key).toBe('first');
  write('second');
  expect(getCachedModelConfig('Fresh', 'global', user)?.key).toBe('second');
});

it('PAT 显式无效或不足刷新余量的有效期必须拒绝且错误脱敏', async () => {
  for (const expiry of [
    { expires_at: 'bad' },
    { expires_at: new Date(Date.now() - 1000).toISOString() },
    { expires_at: new Date(Date.now() + 1000).toISOString() },
    { expires_in: 0 },
    { expires_in: 'invalid' },
    { expires_in: 1000 },
  ]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ token: 'secret-job', ...expiry })))
    );
    await expect(exchangeJobToken('secret-pat', 'global')).rejects.toThrow(/expiry/i);
    await expect(exchangeJobToken('secret-pat', 'global')).rejects.not.toThrow(/secret/);
  }
});

it('Qoder 可在真实 ModelRuntime 中离线解析目录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'enso-qoder-'));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider('qoder', qoderProviderConfig());
    expect(runtime.getModels('qoder').length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('两地区离线注册并提供地区专用目录', async () => {
  const dir = setupDir();
  const runtime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider('qoder', qoderProviderConfig());
  runtime.registerProvider('qoder-cn', qoderProviderConfig('cn'));
  expect(runtime.getModels('qoder').some((m) => m.id === 'Lite')).toBe(true);
  expect(runtime.getModels('qoder-cn').some((m) => m.id === 'Lite')).toBe(false);
  expect(qoderProviderConfig('cn').oauth?.name).toBe('Qoder-CN');
});

it('PAT 登录与刷新各自交换令牌，错误不会延长过期凭据', async () => {
  setupDir();
  let count = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('jobToken/exchange'))
        return new Response(JSON.stringify({ token: `job-${++count}`, expires_in: 3600000 }));
      return new Response(JSON.stringify({ id: 'user-1', name: 'Alice' }));
    })
  );
  const oauth = qoderProviderConfig('cn').oauth!;
  const callbacks = {
    onPrompt: async () => 'pt-secret',
    onAuth: () => {},
    onDeviceCode: () => {},
    onSelect: async () => undefined,
    onProgress: () => {},
  };
  const credentials = await oauth.login(callbacks);
  expect(credentials.access).toBe('job-1');
  expect(credentials.userID).toBe('user-1');
  expect((await oauth.refreshToken(credentials, new AbortController().signal)).access).toBe(
    'job-2'
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('pt-secret', { status: 401 }))
  );
  await expect(oauth.refreshToken(credentials, new AbortController().signal)).rejects.toThrow(
    /401/
  );
  await expect(oauth.refreshToken(credentials, new AbortController().signal)).rejects.not.toThrow(
    /pt-secret/
  );
});

it('CN 空输入取消，坏的 PAT 响应拒绝', async () => {
  setupDir();
  const oauth = qoderProviderConfig('cn').oauth!;
  const callbacks = {
    onPrompt: async () => '',
    onAuth: () => {},
    onDeviceCode: () => {},
    onSelect: async () => undefined,
  };
  await expect(oauth.login(callbacks)).rejects.toThrow();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}'))
  );
  await expect(oauth.login({ ...callbacks, onPrompt: async () => 'pt-test' })).rejects.toThrow();
});

it('global 留空通过浏览器设备流登录，支持取消', async () => {
  setupDir();
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('deviceToken/poll')
              ? {
                  token: 'browser-job',
                  user_id: 'browser-user',
                  refresh_token: 'browser-refresh',
                  expires_in: 3600,
                }
              : { name: 'Browser' }
          )
        )
    )
  );
  const oauth = qoderProviderConfig().oauth!;
  const onAuth = vi.fn();
  const callbacks = {
    onPrompt: async () => '',
    onAuth,
    onDeviceCode: () => {},
    onSelect: async () => undefined,
  };
  const login = oauth.login(callbacks);
  await vi.advanceTimersByTimeAsync(2100);
  const credential = await login;
  expect(onAuth.mock.calls[0][0].url).toContain('qoder.com/device/');
  expect(credential).toMatchObject({ access: 'browser-job', userID: 'browser-user' });
  const controller = new AbortController();
  controller.abort();
  await expect(oauth.login({ ...callbacks, signal: controller.signal })).rejects.toThrow();
});

it('动态目录按地区和用户隔离，离线复用并忽略空响应', async () => {
  setupDir();
  const config = qoderProviderConfig();
  const send = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          chat: [null, { key: 'upstream-a', display_name: 'Friendly Model', enable: true }],
        })
      )
  );
  vi.stubGlobal('fetch', send);
  const credential = {
    type: 'oauth' as const,
    access: 'job-a',
    refresh: '',
    expires: 1,
    userID: 'user-a',
    machineID: 'device-a',
  };
  const context = {
    credential,
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  };
  const models = await config.refreshModels!(context);
  expect(models.map((model) => model.id)).toEqual(['FriendlyModel']);
  const offline = await config.refreshModels!({ ...context, allowNetwork: false });
  expect(offline.map((model) => model.id)).toEqual(['FriendlyModel']);
  expect(
    (
      await config.refreshModels!({
        ...context,
        allowNetwork: false,
        credential: { ...credential, userID: 'user-b' },
      })
    ).some((m) => m.id === 'FriendlyModel')
  ).toBe(false);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}'))
  );
  expect((await config.refreshModels!(context)).map((m) => m.id)).toEqual(['FriendlyModel']);
  const key = config.oauth!.getApiKey(credential);
  const sendChat = vi.fn(async () => new Response('data: [DONE]\n\n'));
  const model = { ...staticModels[0], id: 'FriendlyModel', name: 'Friendly Model' };
  const result = await config.streamSimple!(model, normalizeContext({ messages: [] }), {
    apiKey: key,
    fetch: sendChat as typeof fetch,
  }).result();
  expect(result.stopReason).toBe('stop');
  const init = (sendChat.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(init.headers).toMatchObject({ 'X-Model-Key': 'upstream-a', 'Cosy-User': 'user-a' });
});

it('请求按账号携带身份，CN 副账号走 CN 并保留思考与工具', async () => {
  setupDir();
  const config = qoderProviderConfig('cn');
  const model = { ...staticCnModels[0], provider: 'qoder-cn#2' };
  const context = normalizeContext({
    systemPrompt: 'system-test',
    tools: [
      {
        name: 'read',
        description: 'read',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
  });
  const envelope = (delta: unknown) =>
    `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta }] }) })}\n\n`;
  const body =
    envelope({ reasoning_content: 'think' }) +
    envelope({ content: 'hello' }) +
    envelope({
      tool_calls: [
        { index: 0, id: 'call1', function: { name: 'read', arguments: '{"path":"a"}' } },
      ],
    }) +
    'data: [DONE]\n\n';
  const send = vi.fn(async () => new Response(body));
  const key = config.oauth!.getApiKey({
    access: 'job-B',
    refresh: '',
    expires: 1,
    userID: 'user-B',
    machineID: 'device-B',
    name: 'B',
    email: 'b@example.com',
  });
  const output = config.streamSimple!(model, context, { apiKey: key, fetch: send as typeof fetch });
  const result = await output.result();
  expect(result.stopReason).toBe('toolUse');
  expect(result.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'thinking', thinking: 'think' }),
      expect.objectContaining({ type: 'text', text: 'hello' }),
      expect.objectContaining({ type: 'toolCall', name: 'read', arguments: { path: 'a' } }),
    ])
  );
  const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain('gateway.qoder.com.cn');
  expect(init.headers).toMatchObject({ 'Cosy-User': 'user-B', 'Cosy-Machineid': 'device-B' });
  const payload = JSON.parse(qoderDecodeBody(Buffer.from(init.body as Uint8Array)));
  expect(JSON.stringify(payload)).toContain('system-test');
  expect(JSON.stringify(payload)).toContain('read');
});

it('取消的请求报告 aborted', async () => {
  setupDir();
  const config = qoderProviderConfig();
  const model = staticModels[0];
  const controller = new AbortController();
  controller.abort();
  const key = config.oauth!.getApiKey({
    access: 'job',
    refresh: '',
    expires: 1,
    userID: 'u',
    machineID: 'm',
  });
  const result = await config.streamSimple!(model, normalizeContext({ messages: [] }), {
    apiKey: key,
    signal: controller.signal,
  }).result();
  expect(result.stopReason).toBe('aborted');
});

it('工具结果与请求 hook 进入编码载荷，两个账号不会串号', async () => {
  setupDir();
  const config = qoderProviderConfig();
  const model = staticModels[0];
  const credentials = (suffix: string) => ({
    access: `job-${suffix}`,
    refresh: '',
    expires: 1,
    userID: `user-${suffix}`,
    machineID: `device-${suffix}`,
  });
  const context = normalizeContext({
    messages: [
      {
        role: 'assistant',
        api: 'qoder-api',
        provider: 'qoder',
        model: model.id,
        content: [{ type: 'toolCall', id: 'call|id', name: 'read', arguments: { path: 'x' } }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: 'call|id',
        toolName: 'read',
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
        timestamp: 0,
      },
    ],
  });
  const data = `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: 'done' } }] }) })}\n\ndata: [DONE]\n\n`;
  const fetchMock = vi.fn(async () => new Response(data, { headers: { 'x-test': 'present' } }));
  const onResponse = vi.fn();
  const onProviderStreamEvent = vi.fn();
  const onPayload = vi.fn((payload: unknown) => ({ ...(payload as object), testMarker: 'marker' }));
  const keys = ['a', 'b'].map((suffix) => config.oauth!.getApiKey(credentials(suffix)));
  await Promise.all(
    keys.map((apiKey) =>
      config.streamSimple!(model, context, {
        apiKey,
        fetch: fetchMock as typeof fetch,
        onPayload,
        onResponse,
        onProviderStreamEvent,
      }).result()
    )
  );
  const requests = fetchMock.mock.calls as unknown as [string, RequestInit][];
  expect(requests.map(([, init]) => (init.headers as Record<string, string>)['Cosy-User'])).toEqual(
    ['user-a', 'user-b']
  );
  expect(
    requests.map(([, init]) => (init.headers as Record<string, string>)['Cosy-Machineid'])
  ).toEqual(['device-a', 'device-b']);
  const wire = JSON.parse(qoderDecodeBody(Buffer.from(requests[0][1].body as Uint8Array)));
  expect(JSON.stringify(wire)).toContain('file contents');
  expect(wire.testMarker).toBe('marker');
  expect(onPayload).toHaveBeenCalledTimes(2);
  expect(onResponse).toHaveBeenCalledTimes(2);
  expect(onProviderStreamEvent).toHaveBeenCalledTimes(2);
});

const chatKey = (config: ReturnType<typeof qoderProviderConfig>) =>
  config.oauth!.getApiKey({ access: 'job', refresh: '', expires: 1, userID: 'u', machineID: 'm' });
const sse = (payload: unknown) =>
  `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(payload) })}`;

it('设备登录单次轮询超时后继续轮询', async () => {
  setupDir();
  vi.useFakeTimers();
  let polls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.includes('deviceToken/poll')) return new Response('{}');
      if (++polls === 1) throw new DOMException('timed out', 'TimeoutError');
      return new Response(
        JSON.stringify({ token: 'job', user_id: 'user', refresh_token: 'rt', expires_in: 3600 })
      );
    })
  );
  const login = qoderProviderConfig().oauth!.login({
    onPrompt: async () => '',
    onAuth: () => {},
    onDeviceCode: () => {},
    onSelect: async () => undefined,
  });
  const settled = login.then(
    (value) => value,
    (error: unknown) => error
  );
  await vi.advanceTimersByTimeAsync(4200);
  expect(await settled).toMatchObject({ access: 'job', userID: 'user' });
});

it('PAT 刷新时身份查询失败沿用已有 userID', async () => {
  setupDir();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('jobToken/exchange')
        ? new Response(JSON.stringify({ token: 'job-new', expires_in: 3600000 }))
        : new Response('', { status: 500 })
    )
  );
  const refreshed = await qoderProviderConfig('cn').oauth!.refreshToken(
    { access: 'job-old', refresh: encodePatRefresh('pt-x', '', 'user-1', 'm-1'), expires: 1 },
    new AbortController().signal
  );
  expect(refreshed).toMatchObject({ access: 'job-new', userID: 'user-1' });
});

it('携带凭证或正文的请求不跟随重定向', async () => {
  setupDir();
  const send = vi.fn(async (url: string) =>
    url.includes('jobToken/exchange')
      ? new Response(JSON.stringify({ token: 'job', expires_in: 3600000 }))
      : new Response(JSON.stringify({ id: 'u', token: 'job', expires_in: 3600 }))
  );
  vi.stubGlobal('fetch', send);
  const oauth = qoderProviderConfig().oauth!;
  await oauth.refreshToken(
    { access: 'a', refresh: encodePatRefresh('pt-x', '', 'u', 'm'), expires: 1 },
    new AbortController().signal
  );
  await oauth.refreshToken(
    { access: 'a', refresh: 'rt|u|m', expires: 1 },
    new AbortController().signal
  );
  const config = qoderProviderConfig();
  const chat = vi.fn(async () => new Response('data: [DONE]\n\n'));
  await config.streamSimple!(staticModels[0], normalizeContext({ messages: [] }), {
    apiKey: chatKey(config),
    fetch: chat as typeof fetch,
  }).result();
  const calls = [...send.mock.calls, ...chat.mock.calls] as unknown as [string, RequestInit?][];
  const withBody = calls.filter(([, init]) => init?.method === 'POST');
  expect(withBody.length).toBe(3);
  for (const [, init] of withBody) expect(init?.redirect).toBe('manual');
});

it('连接结束时解析未换行的尾块，截断的工具参数按可重试错误结束', async () => {
  setupDir();
  const config = qoderProviderConfig();
  const run = (body: string) =>
    config.streamSimple!(staticModels[0], normalizeContext({ messages: [] }), {
      apiKey: chatKey(config),
      fetch: (async () => new Response(body)) as typeof fetch,
    }).result();
  const tail = await run(sse({ choices: [{ delta: { content: 'tail' } }] }));
  expect(tail.content).toEqual([expect.objectContaining({ type: 'text', text: 'tail' })]);
  const cut = await run(
    `${sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":' } }] } }] })}\n\n` +
      'data: {"statusCodeValue":200,"body":"{\\"choices'
  );
  expect(cut.stopReason).toBe('error');
  expect(cut.errorMessage).toMatch(/cut off/);
});

it('CN 副账号用量标记为 qoder-cn', async () => {
  setupDir();
  const config = qoderProviderConfig('cn');
  const body = `${sse({ choices: [{ delta: { content: 'x' } }], usage: { prompt_tokens: 1 } })}\n\ndata: [DONE]\n\n`;
  const result = await config.streamSimple!(
    { ...staticCnModels[0], provider: 'qoder-cn#2' },
    normalizeContext({ messages: [] }),
    { apiKey: chatKey(config), fetch: (async () => new Response(body)) as typeof fetch }
  ).result();
  expect((result.usage as { qoder_provider?: string }).qoder_provider).toBe('qoder-cn');
});
