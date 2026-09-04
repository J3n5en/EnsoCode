import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OauthFlowEvent } from '@shared/capabilities/types';
import type { OauthLoginEvent } from '@shared/types';
import { IPC_CHANNELS, OAUTH_LABEL_MAX_LENGTH } from '@shared/types';
import type { WebContents } from 'electron';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// app.getPath 指到临时目录：整条链路（ModelRuntime.create → listCredentials →
// readStoredCredential）都真的读盘，不能污染本机 userData
const userData = mkdtempSync(path.join(tmpdir(), 'enso-oauth-'));
const electronMocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => {}),
  windows: [] as Array<{
    isDestroyed: () => boolean;
    webContents: Pick<WebContents, 'isDestroyed' | 'send'>;
  }>,
}));
vi.mock('electron', () => ({
  app: { getPath: () => userData, getName: () => 'enso-code', on: () => {} },
  BrowserWindow: { getAllWindows: () => electronMocks.windows },
  shell: { openExternal: electronMocks.openExternal },
}));
vi.mock('./proxyConfig', () => ({
  getProxyConfig: () => ({ whenReady: async () => true }),
}));

/** 造一个可解码的 JWT（只有 payload 有意义，签名不校验） */
function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
}

const expires = Date.now() + 3_600_000;

beforeAll(() => {
  const dir = path.join(userData, 'agent', 'pi-agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'auth.json'),
    JSON.stringify({
      anthropic: { type: 'oauth', access: 'sk-ant-oat01-one', refresh: 'r1', expires },
      'anthropic#2': { type: 'oauth', access: 'sk-ant-oat01-two', refresh: 'r2', expires },
      cursor: {
        type: 'oauth',
        access: 'cursor-access-token',
        refresh: 'cursor-refresh-token',
        expires,
      },
      'openai-codex': {
        type: 'oauth',
        access: fakeJwt({
          email: 'user@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
        }),
        refresh: 'r3',
        expires,
      },
      // Antigravity 的凭证自带 projectId / email（pi 不拒绝额外字段）
      'google-antigravity': {
        type: 'oauth',
        access: 'ya29.access-token',
        refresh: 'r4',
        expires,
        projectId: 'projects/enso-test',
        email: 'ag@example.com',
      },
      // api key 凭证不该被当成订阅账号
      openai: { type: 'api_key', key: 'sk-test' },
    })
  );
});

afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe('listOauthProviders 的账号枚举', () => {
  it('同一厂商的两个账号各占一行，裸 key 排在 #2 前面', async () => {
    const { listOauthProviders } = await import('./oauthProviders');
    const providers = await listOauthProviders();
    const anthropic = providers.find((provider) => provider.id === 'anthropic');
    expect(anthropic?.accounts.map((account) => account.key)).toEqual(['anthropic', 'anthropic#2']);
    expect(anthropic?.accounts.every((account) => account.providerId === 'anthropic')).toBe(true);
  });

  it('列表明确区分 Cursor 单账号限制与其他 provider 的多账号能力', async () => {
    const { listOauthProviders } = await import('./oauthProviders');
    const providers = await listOauthProviders();
    expect(providers.find((provider) => provider.id === 'cursor')?.supportsMultipleAccounts).toBe(
      false
    );
    expect(
      providers.find((provider) => provider.id === 'anthropic')?.supportsMultipleAccounts
    ).toBe(true);
  });

  it('access token 是 JWT 时，email 与套餐不发网络请求就能读出来', async () => {
    const { listOauthProviders } = await import('./oauthProviders');
    const providers = await listOauthProviders();
    const codex = providers.find((provider) => provider.id === 'openai-codex');
    expect(codex?.accounts).toEqual([
      { key: 'openai-codex', providerId: 'openai-codex', email: 'user@example.com', plan: 'plus' },
    ]);
  });

  it('未登录的 provider 是空 accounts 数组，api_key 凭证不算订阅账号', async () => {
    const { listOauthProviders } = await import('./oauthProviders');
    const providers = await listOauthProviders();
    const xai = providers.find((provider) => provider.id === 'xai');
    expect(xai?.accounts).toEqual([]);
    // openai 只有 api_key 凭证，不该出现在订阅列表里凭空多出一个账号
    const openai = providers.find((provider) => provider.id === 'openai');
    expect(openai?.accounts ?? []).toEqual([]);
  });

  it('合成 id 的克隆 provider 不作为独立条目暴露给界面', async () => {
    const { listOauthProviders } = await import('./oauthProviders');
    const providers = await listOauthProviders();
    expect(providers.some((provider) => provider.id.includes('#'))).toBe(false);
  });

  it('Antigravity 已注册进 runtime，作为可登录的订阅 provider 出现', async () => {
    const { listOauthProviders } = await import('./oauthProviders');
    const providers = await listOauthProviders();
    const antigravity = providers.find((provider) => provider.id === 'google-antigravity');
    expect(antigravity).toBeDefined();
    expect(antigravity?.models.length).toBeGreaterThan(0);
  });

  it('Antigravity 的 email 直接来自凭证，列表不必等网络', async () => {
    const { listOauthProviders } = await import('./oauthProviders');
    const providers = await listOauthProviders();
    const antigravity = providers.find((provider) => provider.id === 'google-antigravity');
    expect(antigravity?.accounts).toEqual([
      { key: 'google-antigravity', providerId: 'google-antigravity', email: 'ag@example.com' },
    ]);
  });

  it('JWT 里超长 plan 按共享上限截断', async () => {
    const restore = withAuthJson((parsed) => {
      parsed['openai-codex'] = {
        type: 'oauth',
        access: fakeJwt({
          email: 'huge@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'P'.repeat(200) },
        }),
        refresh: 'r3',
        expires,
      };
    });
    try {
      const { listOauthProviders } = await import('./oauthProviders');
      const providers = await listOauthProviders();
      const codex = providers.find((provider) => provider.id === 'openai-codex');
      expect(codex?.accounts[0]?.plan).toBe('P'.repeat(OAUTH_LABEL_MAX_LENGTH));
    } finally {
      restore();
    }
  });
});

/** 收集 OAUTH_LOGIN_EVENT 的假 WebContents */
let nextSenderId = 100;
function fakeSender(): {
  sender: WebContents;
  events: OauthLoginEvent[];
  flowEvents: OauthFlowEvent[];
} {
  const events: OauthLoginEvent[] = [];
  const flowEvents: OauthFlowEvent[] = [];
  const sender = {
    id: nextSenderId++,
    isDestroyed: () => false,
    send: (_channel: string, payload: OauthFlowEvent) => {
      flowEvents.push(payload);
      if (payload.event.type === 'progress' && payload.event.message === 'Starting login...') {
        return;
      }
      events.push(payload.event);
    },
  };
  return { sender: sender as unknown as WebContents, events, flowEvents };
}

async function completeOauthLogin(providerId: string, sender: WebContents) {
  const { beginOauthLogin } = await import('./oauthProviders');
  const identity = {
    flowId: crypto.randomUUID(),
    ownerWebContentsId: sender.id,
    host: 'provider-wizard' as const,
  };
  const handle = beginOauthLogin(providerId, sender, identity);
  if (handle.completion) await handle.completion;
  return handle;
}

describe('OAuth 凭证跨窗口失效通知', () => {
  it('只通知其它存活 renderer，发起窗口由本地 done/logout 路径刷新', async () => {
    const sourceSend = vi.fn();
    const otherSend = vi.fn();
    const destroyedSend = vi.fn();
    const source = {
      isDestroyed: () => false,
      send: sourceSend,
    };
    electronMocks.windows.push(
      {
        isDestroyed: () => false,
        webContents: source,
      },
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: otherSend },
      },
      {
        isDestroyed: () => true,
        webContents: { isDestroyed: () => false, send: destroyedSend },
      }
    );
    try {
      const { broadcastOauthCredentialsChanged } = await import('./oauthProviders');
      broadcastOauthCredentialsChanged(source as unknown as WebContents);
      expect(sourceSend).not.toHaveBeenCalled();
      expect(destroyedSend).not.toHaveBeenCalled();
      expect(otherSend).toHaveBeenCalledOnce();
      expect(otherSend).toHaveBeenCalledWith(IPC_CHANNELS.OAUTH_CREDENTIALS_CHANGED);
    } finally {
      electronMocks.windows.splice(0);
    }
  });

  it('成功退登一个合成账号后广播，且同厂商其它账号仍保留', async () => {
    const restore = withAuthJson(() => {});
    const sourceSend = vi.fn();
    const otherSend = vi.fn();
    const source = {
      isDestroyed: () => false,
      send: sourceSend,
    };
    electronMocks.windows.push(
      {
        isDestroyed: () => false,
        webContents: source,
      },
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: otherSend },
      }
    );
    try {
      const { listOauthProviders, oauthLogout } = await import('./oauthProviders');
      await oauthLogout('anthropic#2', source as unknown as WebContents);
      const providers = await listOauthProviders();
      expect(
        providers
          .find((provider) => provider.id === 'anthropic')
          ?.accounts.map((account) => account.key)
      ).toEqual(['anthropic']);
      expect(otherSend).toHaveBeenCalledWith(IPC_CHANNELS.OAUTH_CREDENTIALS_CHANGED);
      expect(sourceSend).not.toHaveBeenCalled();
    } finally {
      restore();
      electronMocks.windows.splice(0);
      const { listOauthProviders } = await import('./oauthProviders');
      await listOauthProviders();
    }
  });
});

// 渲染层可以往这三个通道传任意字符串，而它们最终都会被当成 auth.json 的键使用。
// 安全评审 P1：不收窄的话「登录」能覆盖已登录账号的凭证。
describe('IPC 入参收窄', () => {
  it('登录时传合成 id 被拒，不会覆盖该账号已有的凭证', async () => {
    const { listOauthProviders } = await import('./oauthProviders');
    const { sender, events } = fakeSender();
    await completeOauthLogin('anthropic#2', sender);
    expect(events).toEqual([{ type: 'error', message: 'unknown oauth provider: anthropic#2' }]);
    const providers = await listOauthProviders();
    const anthropic = providers.find((provider) => provider.id === 'anthropic');
    expect(anthropic?.accounts.map((account) => account.key)).toEqual(['anthropic', 'anthropic#2']);
  });

  it('Cursor 已登录时拒绝再登一个账号，且不覆盖既有凭证', async () => {
    const file = path.join(userData, 'agent', 'pi-agent', 'auth.json');
    const before = JSON.parse(readFileSync(file, 'utf8')).cursor;
    const { sender, events } = fakeSender();
    await completeOauthLogin('cursor', sender);
    expect(events).toEqual([
      { type: 'error', message: 'cursor does not support multiple accounts' },
    ]);
    const after = JSON.parse(readFileSync(file, 'utf8')).cursor;
    expect(after).toEqual(before);
  });

  it('登录时传不存在的 provider 被拒', async () => {
    const { sender, events } = fakeSender();
    await completeOauthLogin('../../../etc/passwd', sender);
    expect(events[0]).toMatchObject({ type: 'error' });
  });

  it('登录时传只有 api_key 支持的 provider 被拒（openai 无 oauth 登录）', async () => {
    const { sender, events } = fakeSender();
    await completeOauthLogin('openai', sender);
    expect(events).toEqual([{ type: 'error', message: 'unknown oauth provider: openai' }]);
  });

  it('被拒后登录锁已释放，下一次仍能进入流程', async () => {
    const first = fakeSender();
    await completeOauthLogin('anthropic#2', first.sender);
    const second = fakeSender();
    await completeOauthLogin('anthropic#2', second.sender);
    expect(second.events[0]).not.toMatchObject({ message: 'login already in progress' });
  });

  it('登出 auth.json 里不存在的 key 是 no-op，不动其他账号', async () => {
    const { oauthLogout, listOauthProviders } = await import('./oauthProviders');
    await oauthLogout('anthropic#9');
    const providers = await listOauthProviders();
    const anthropic = providers.find((provider) => provider.id === 'anthropic');
    expect(anthropic?.accounts.map((account) => account.key)).toEqual(['anthropic', 'anthropic#2']);
  });

  it('查不存在的账号额度直接返回 error，不发网络请求', async () => {
    const { getOauthAccountUsage } = await import('./oauthProviders');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const usage = await getOauthAccountUsage('anthropic#9');
    expect(usage).toEqual({
      key: 'anthropic#9',
      windows: [],
      error: 'unknown account: anthropic#9',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('api_key 凭证的 key 不算订阅账号，查额度同样被拒', async () => {
    const { getOauthAccountUsage } = await import('./oauthProviders');
    const usage = await getOauthAccountUsage('openai');
    expect(usage.error).toBe('unknown account: openai');
  });
});

// 真实踩过的坑：antigravity 的 auth.apiKey 不是裸 token，而是
// {access, refresh, expires, projectId, email} 的 JSON（projectId 得随 token 一起进 streamSimple）。
// 整段当 Bearer 打过去会 401，再被 best-effort 静默成空窗口，长得就像「接了但没数据」。
describe('Antigravity 额度探测', () => {
  it('用解开的 access token 打请求，绝不把整段凭证 JSON 当 Bearer', async () => {
    const { getOauthAccountUsage } = await import('./oauthProviders');
    const seenAuth: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      seenAuth.push(new Headers(init?.headers).get('authorization') ?? '');
      void input;
      return new Response(
        JSON.stringify({
          models: {
            'gemini-3-pro': {
              modelProvider: 'GOOGLE',
              quotaInfo: { remainingFraction: 0.25, resetTime: new Date(expires).toISOString() },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const usage = await getOauthAccountUsage('google-antigravity');

    expect(usage.error).toBeUndefined();
    expect(usage.windows).toEqual([
      { label: 'Google Daily', usedPercent: 75, resetsAt: expect.any(Number) },
    ]);
    expect(seenAuth).toContain('Bearer ya29.access-token');
    expect(seenAuth.some((value) => value.includes('projectId'))).toBe(false);
    fetchSpy.mockRestore();
  });

  it('厂商 windowLabel 超长时按共享上限截断', async () => {
    const { getOauthAccountUsage } = await import('./oauthProviders');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          models: {
            'gemini-3-pro': {
              quotaInfo: {
                remainingFraction: 0.4,
                resetTime: new Date(expires).toISOString(),
                windowLabel: 'W'.repeat(200),
              },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    try {
      const usage = await getOauthAccountUsage('google-antigravity');
      expect(usage.error).toBeUndefined();
      expect(usage.windows).toHaveLength(1);
      expect(usage.windows[0]?.label).toBe('W'.repeat(OAUTH_LABEL_MAX_LENGTH));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('凭证缺 projectId 时落到 error 而不是静默空窗口', async () => {
    const { getOauthAccountUsage } = await import('./oauthProviders');
    const broken = path.join(userData, 'agent', 'pi-agent', 'auth.json');
    const original = readFileSync(broken, 'utf8');
    const parsed = JSON.parse(original);
    parsed['google-antigravity'] = { type: 'oauth', access: 'ya29.x', refresh: 'r', expires };
    writeFileSync(broken, JSON.stringify(parsed));
    try {
      const usage = await getOauthAccountUsage('google-antigravity');
      expect(usage.windows).toEqual([]);
      expect(usage.error).toMatch(/projectId/);
    } finally {
      writeFileSync(broken, original);
    }
  });
});

const authFile = () => path.join(userData, 'agent', 'pi-agent', 'auth.json');

function withAuthJson(mutate: (parsed: Record<string, unknown>) => void): () => void {
  const original = readFileSync(authFile(), 'utf8');
  const parsed = JSON.parse(original) as Record<string, unknown>;
  mutate(parsed);
  writeFileSync(authFile(), JSON.stringify(parsed));
  return () => writeFileSync(authFile(), original);
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('xAI 额度探测', () => {
  it('打 CLI billing 周池，带 xai-grok-cli 头，映射成 7d 窗口', async () => {
    const restore = withAuthJson((parsed) => {
      parsed.xai = {
        type: 'oauth',
        access: fakeJwt({ sub: 'xai-user-1' }),
        refresh: 'rx',
        expires,
      };
    });
    const seen: Array<{ url: string; auth: string | null; tokenAuth: string | null }> = [];
    const periodEnd = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({
        url,
        auth: headers.get('authorization'),
        tokenAuth: headers.get('x-xai-token-auth'),
      });
      if (url.includes('/oauth2/userinfo')) {
        return jsonOk({ email: 'grok@example.com' });
      }
      if (url.includes('format=credits')) {
        return jsonOk({
          config: {
            creditUsagePercent: 18,
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_WEEKLY',
              start: new Date(Date.now() - 5 * 86_400_000).toISOString(),
              end: periodEnd,
            },
          },
        });
      }
      return jsonOk({});
    });
    try {
      const { getOauthAccountUsage } = await import('./oauthProviders');
      const usage = await getOauthAccountUsage('xai');
      expect(usage.error).toBeUndefined();
      expect(usage.windows).toEqual([
        { label: '7d', usedPercent: 18, resetsAt: Date.parse(periodEnd) },
      ]);
      const billing = seen.find((call) => call.url.includes('format=credits'));
      expect(billing?.tokenAuth).toBe('xai-grok-cli');
      expect(billing?.auth).toMatch(/^Bearer /);
      expect(seen.some((call) => call.url === 'https://cli-chat-proxy.grok.com/v1/billing')).toBe(
        false
      );
    } finally {
      fetchSpy.mockRestore();
      restore();
    }
  });

  it('unified 账号缺周百分比时改打月池', async () => {
    const restore = withAuthJson((parsed) => {
      parsed.xai = {
        type: 'oauth',
        access: fakeJwt({ sub: 'xai-user-2' }),
        refresh: 'rx',
        expires,
      };
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/oauth2/userinfo')) return jsonOk({ email: 'grok@example.com' });
      if (url.includes('format=credits')) {
        return jsonOk({
          config: {
            isUnifiedBillingUser: true,
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_WEEKLY',
              start: new Date(Date.now() - 86_400_000).toISOString(),
              end: new Date(Date.now() + 6 * 86_400_000).toISOString(),
            },
          },
        });
      }
      if (url.endsWith('/v1/billing')) {
        return jsonOk({
          config: {
            monthlyLimit: { val: 15000 },
            used: { val: 4500 },
            billingPeriodEnd: '2026-09-01T00:00:00Z',
          },
        });
      }
      return jsonOk({});
    });
    try {
      const { getOauthAccountUsage } = await import('./oauthProviders');
      const usage = await getOauthAccountUsage('xai');
      expect(usage.error).toBeUndefined();
      expect(usage.windows).toEqual([
        { label: 'mo', usedPercent: 30, resetsAt: Date.parse('2026-09-01T00:00:00Z') },
      ]);
    } finally {
      fetchSpy.mockRestore();
      restore();
    }
  });
});

describe('Cursor 额度探测', () => {
  it('JWT 账号走 usage-summary 的 auto/api 百分比', async () => {
    const access = fakeJwt({ sub: 'auth0|user_cursor_1' });
    const restore = withAuthJson((parsed) => {
      parsed.cursor = { type: 'oauth', access, refresh: 'cr', expires };
    });
    const cycleEnd = Date.now() + 10 * 86_400_000;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/usage-summary')) {
        return jsonOk({
          billingCycleEnd: cycleEnd,
          individualUsage: {
            plan: { autoPercentUsed: 12, apiPercentUsed: 34, enabled: true },
          },
        });
      }
      if (url.includes('/api/auth/me')) return jsonOk({ email: 'cursor@example.com' });
      return jsonOk({});
    });
    try {
      const { getOauthAccountUsage } = await import('./oauthProviders');
      const usage = await getOauthAccountUsage('cursor');
      expect(usage.error).toBeUndefined();
      expect(usage.windows).toEqual([
        { label: 'auto', usedPercent: 12, resetsAt: cycleEnd },
        { label: 'api', usedPercent: 34, resetsAt: cycleEnd },
      ]);
    } finally {
      fetchSpy.mockRestore();
      restore();
    }
  });

  it('非 JWT token 退到 GetCurrentPeriodUsage', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('GetCurrentPeriodUsage')) {
        expect(init?.method).toBe('POST');
        return jsonOk({
          billingCycleEnd: '1771077734000',
          planUsage: { autoPercentUsed: 8, apiPercentUsed: 21, enabled: true },
        });
      }
      if (url.includes('cursor.com')) {
        throw new Error('session endpoints must not be called without user id');
      }
      return jsonOk({});
    });
    try {
      const { getOauthAccountUsage } = await import('./oauthProviders');
      const usage = await getOauthAccountUsage('cursor');
      expect(usage.error).toBeUndefined();
      expect(usage.windows).toEqual([
        { label: 'auto', usedPercent: 8, resetsAt: 1_771_077_734_000 },
        { label: 'api', usedPercent: 21, resetsAt: 1_771_077_734_000 },
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('登录事件安全边界', () => {
  it('完整授权地址只留在 Main，重开仍用原地址且错误正文不超过 300 字', async () => {
    vi.resetModules();
    electronMocks.openExternal.mockClear();

    const fullAuthUrl =
      'https://accounts.example.test/oauth/authorize?state=csrf-secret&client_id=enso';
    const upstreamError = `${JSON.stringify({ access_token: 'ya29.secret' })}${'x'.repeat(600)}`;
    const loginOutcome = Promise.withResolvers<void>();
    interface FakeProvider {
      id: string;
      name: string;
      auth: { oauth: { name: string } };
      getModels: () => never[];
    }
    const providers: FakeProvider[] = [
      {
        id: 'throwing-oauth',
        name: 'Throwing OAuth',
        auth: { oauth: { name: 'Throwing OAuth' } },
        getModels: () => [],
      },
    ];
    const runtime = {
      registerProvider: (id: string) => {
        providers.push({
          id,
          name: id,
          auth: { oauth: { name: id } },
          getModels: () => [],
        });
      },
      registerNativeProvider: (provider: FakeProvider) => providers.push(provider),
      unregisterProvider: (id: string) => {
        const index = providers.findIndex((provider) => provider.id === id);
        if (index !== -1) providers.splice(index, 1);
      },
      getProvider: (id: string) => providers.find((provider) => provider.id === id),
      getProviders: () => providers,
      listCredentials: async () => [],
      refresh: async () => {},
      login: async (
        _providerId: string,
        _method: string,
        interaction: {
          notify: (event: { type: 'auth_url'; url: string; instructions?: string }) => void;
        }
      ) => {
        interaction.notify({
          type: 'auth_url',
          url: fullAuthUrl,
          instructions: 'Complete login',
        });
        await loginOutcome.promise;
      },
    };
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      ModelRuntime: { create: async () => runtime },
    }));

    try {
      const { beginOauthLogin, cancelOauthLogin, reopenOauthLogin, respondOauthPrompt } =
        await import('./oauthProviders');
      const { sender, events, flowEvents } = fakeSender();
      const child = {
        sessionId: 'parent::enso-1',
        generation: '11111111-1111-4111-8111-111111111111',
        parent: {
          sessionId: 'parent',
          generation: '22222222-2222-4222-8222-222222222222',
        },
        instanceId: '33333333-3333-4333-8333-333333333333',
        instanceName: 'Enso',
        typeKey: 'agent:enso' as const,
        profileId: 'enso-locked-v1' as const,
      };
      const locator = {
        flowId: crypto.randomUUID(),
        ownerWebContentsId: sender.id,
        host: 'agent-child-tab' as const,
        child,
        turnId: 'turn-a',
        requestId: 'request-a',
      };
      const handle = beginOauthLogin('throwing-oauth', sender, locator);
      expect(handle.start).toEqual({ status: 'started', locator });
      const running = handle.completion;
      await vi.waitFor(() => {
        expect(events).toContainEqual({
          type: 'auth_url',
          url: 'https://accounts.example.test/oauth/authorize',
          instructions: 'Complete login',
        });
      });
      expect(flowEvents.every((event) => event.locator === locator)).toBe(true);
      expect(electronMocks.openExternal).toHaveBeenCalledTimes(1);
      expect(electronMocks.openExternal).toHaveBeenLastCalledWith(fullAuthUrl);

      const foreignChild = {
        ...locator,
        child: {
          ...child,
          sessionId: 'parent::enso-2',
          instanceId: '44444444-4444-4444-8444-444444444444',
        },
      };
      const oldTurn = { ...locator, turnId: 'turn-old' };
      expect(cancelOauthLogin(foreignChild)).toBe(false);
      expect(reopenOauthLogin(foreignChild)).toBe(false);
      expect(respondOauthPrompt(foreignChild, 'missing', 'value')).toBe(false);
      expect(cancelOauthLogin(oldTurn)).toBe(false);
      expect(reopenOauthLogin(locator)).toBe(true);
      expect(electronMocks.openExternal).toHaveBeenCalledTimes(2);
      expect(electronMocks.openExternal).toHaveBeenLastCalledWith(fullAuthUrl);

      loginOutcome.reject(new Error(upstreamError));
      await running;
      const errorEvent = events.find((event) => event.type === 'error');
      expect(errorEvent?.message.length).toBeLessThanOrEqual(300);
      expect(errorEvent?.message).not.toContain('ya29.secret');

      expect(reopenOauthLogin(locator)).toBe(false);
      expect(electronMocks.openExternal).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock('@earendil-works/pi-coding-agent');
      vi.resetModules();
    }
  });
});

describe('登录成功凭证失效通知', () => {
  it('done 发给发起窗口后，credentials-changed 广播到其它 renderer', async () => {
    vi.resetModules();
    let loggedIn = false;
    interface FakeProvider {
      id: string;
      name: string;
      auth: { oauth?: { name?: string } };
      getModels: () => string[];
    }
    const providers: FakeProvider[] = [
      {
        id: 'success-oauth',
        name: 'Success OAuth',
        auth: { oauth: { name: 'Success OAuth' } },
        getModels: () => ['success-model'],
      },
    ];
    const runtime = {
      registerProvider: (id: string, config: { oauth?: { name?: string }; models?: unknown[] }) => {
        providers.push({
          id,
          name: config.oauth?.name ?? id,
          auth: { oauth: config.oauth },
          getModels: () => [],
        });
      },
      registerNativeProvider: (provider: FakeProvider) => providers.push(provider),
      unregisterProvider: (id: string) => {
        const index = providers.findIndex((provider) => provider.id === id);
        if (index !== -1) providers.splice(index, 1);
      },
      getProvider: (id: string) => providers.find((provider) => provider.id === id),
      getProviders: () => providers,
      listCredentials: async () =>
        loggedIn ? [{ providerId: 'success-oauth', type: 'oauth' as const }] : [],
      refresh: async () => ({ aborted: false, errors: new Map() }),
      getAuth: async () => ({ auth: { apiKey: 'opaque-success-token' } }),
      login: async () => {
        loggedIn = true;
      },
    };
    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      ModelRuntime: { create: async () => runtime },
    }));

    const sourceSend = vi.fn();
    const otherSend = vi.fn();
    const source = { id: nextSenderId++, isDestroyed: () => false, send: sourceSend };
    electronMocks.windows.push(
      { isDestroyed: () => false, webContents: source },
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: otherSend },
      }
    );
    try {
      const { beginOauthLogin } = await import('./oauthProviders');
      const events: OauthLoginEvent[] = [];
      const sender = {
        ...source,
        send: (channel: string, payload: { event: OauthLoginEvent }) => {
          if (channel === IPC_CHANNELS.OAUTH_LOGIN_EVENT) events.push(payload.event);
          sourceSend(channel, payload);
        },
      } as unknown as WebContents;
      electronMocks.windows[0] = {
        isDestroyed: () => false,
        webContents: sender,
      };
      const identity = {
        flowId: crypto.randomUUID(),
        ownerWebContentsId: sender.id,
        host: 'provider-wizard' as const,
      };
      const handle = beginOauthLogin('success-oauth', sender, identity);
      await handle.completion;

      expect(events).toContainEqual({
        type: 'done',
        providerId: 'success-oauth',
        account: { key: 'success-oauth', providerId: 'success-oauth' },
      });
      expect(otherSend).toHaveBeenCalledWith(IPC_CHANNELS.OAUTH_CREDENTIALS_CHANGED);
      expect(sourceSend).not.toHaveBeenCalledWith(IPC_CHANNELS.OAUTH_CREDENTIALS_CHANGED);
    } finally {
      electronMocks.windows.splice(0);
      vi.doUnmock('@earendil-works/pi-coding-agent');
      vi.resetModules();
    }
  });
});

describe('Main OAuth 真凭证 key 读取', () => {
  it('返回多账号实际 key，忽略 api_key 凭证且不暴露 token', async () => {
    const { readStoredOauthCredentialKeys } = await import('./oauthProviders');
    const keys = await readStoredOauthCredentialKeys();
    expect([...keys].sort()).toEqual(
      ['anthropic', 'anthropic#2', 'cursor', 'google-antigravity', 'openai-codex'].sort()
    );
    expect(keys.has('openai')).toBe(false);
  });

  it('轻量读取不创建 ModelRuntime 或注册 provider', async () => {
    vi.resetModules();
    const create = vi.fn(async () => {
      throw new Error('ModelRuntime must not be created');
    });
    vi.doMock('@earendil-works/pi-coding-agent', () => ({ ModelRuntime: { create } }));
    try {
      const { readStoredOauthCredentialKeys } = await import('./oauthProviders');
      const keys = await readStoredOauthCredentialKeys();
      expect(keys.has('anthropic')).toBe(true);
      expect(create).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('@earendil-works/pi-coding-agent');
      vi.resetModules();
    }
  });

  it('auth.json 不存在时返回空集合', async () => {
    const file = authFile();
    const backup = `${file}.missing-test`;
    rmSync(backup, { force: true });
    renameSync(file, backup);
    try {
      const { readStoredOauthCredentialKeys } = await import('./oauthProviders');
      expect(await readStoredOauthCredentialKeys()).toEqual(new Set());
    } finally {
      renameSync(backup, file);
    }
  });

  it('auth.json 损坏时传播解析错误，不伪装成空账号集合', async () => {
    const file = authFile();
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, '{not-json');
    try {
      const { readStoredOauthCredentialKeys } = await import('./oauthProviders');
      await expect(readStoredOauthCredentialKeys()).rejects.toBeInstanceOf(SyntaxError);
    } finally {
      writeFileSync(file, original);
    }
  });

  it('非 ENOENT 文件系统错误原样上抛', async () => {
    const file = authFile();
    const backup = `${file}.io-error-test`;
    rmSync(backup, { force: true });
    renameSync(file, backup);
    mkdirSync(file);
    try {
      const { readStoredOauthCredentialKeys } = await import('./oauthProviders');
      await expect(readStoredOauthCredentialKeys()).rejects.toMatchObject({ code: 'EISDIR' });
    } finally {
      rmSync(file, { recursive: true, force: true });
      renameSync(backup, file);
    }
  });
});
