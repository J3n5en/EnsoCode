import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OauthLoginEvent } from '@shared/types';
import type { WebContents } from 'electron';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// app.getPath 指到临时目录：整条链路（ModelRuntime.create → listCredentials →
// readStoredCredential）都真的读盘，不能污染本机 userData
const userData = mkdtempSync(path.join(tmpdir(), 'enso-oauth-'));
const electronMocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => {}),
}));
vi.mock('electron', () => ({
  app: { getPath: () => userData, getName: () => 'enso-code', on: () => {} },
  shell: { openExternal: electronMocks.openExternal },
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
});

/** 收集 OAUTH_LOGIN_EVENT 的假 WebContents */
function fakeSender(): { sender: WebContents; events: OauthLoginEvent[] } {
  const events: OauthLoginEvent[] = [];
  const sender = {
    isDestroyed: () => false,
    send: (_channel: string, event: OauthLoginEvent) => events.push(event),
  };
  return { sender: sender as unknown as WebContents, events };
}

// 渲染层可以往这三个通道传任意字符串，而它们最终都会被当成 auth.json 的键使用。
// 安全评审 P1：不收窄的话「登录」能覆盖已登录账号的凭证。
describe('IPC 入参收窄', () => {
  it('登录时传合成 id 被拒，不会覆盖该账号已有的凭证', async () => {
    const { startOauthLogin, listOauthProviders } = await import('./oauthProviders');
    const { sender, events } = fakeSender();
    await startOauthLogin('anthropic#2', sender);
    expect(events).toEqual([{ type: 'error', message: 'unknown oauth provider: anthropic#2' }]);
    const providers = await listOauthProviders();
    const anthropic = providers.find((provider) => provider.id === 'anthropic');
    expect(anthropic?.accounts.map((account) => account.key)).toEqual(['anthropic', 'anthropic#2']);
  });

  it('登录时传不存在的 provider 被拒', async () => {
    const { startOauthLogin } = await import('./oauthProviders');
    const { sender, events } = fakeSender();
    await startOauthLogin('../../../etc/passwd', sender);
    expect(events[0]).toMatchObject({ type: 'error' });
  });

  it('登录时传只有 api_key 支持的 provider 被拒（openai 无 oauth 登录）', async () => {
    const { startOauthLogin } = await import('./oauthProviders');
    const { sender, events } = fakeSender();
    await startOauthLogin('openai', sender);
    expect(events).toEqual([{ type: 'error', message: 'unknown oauth provider: openai' }]);
  });

  it('被拒后登录锁已释放，下一次仍能进入流程', async () => {
    const { startOauthLogin } = await import('./oauthProviders');
    const first = fakeSender();
    await startOauthLogin('anthropic#2', first.sender);
    const second = fakeSender();
    await startOauthLogin('anthropic#2', second.sender);
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
      const { reopenOauthLogin, startOauthLogin } = await import('./oauthProviders');
      const { sender, events } = fakeSender();
      const running = startOauthLogin('throwing-oauth', sender);
      await vi.waitFor(() => {
        expect(events).toContainEqual({
          type: 'auth_url',
          url: 'https://accounts.example.test/oauth/authorize',
          instructions: 'Complete login',
        });
      });
      expect(electronMocks.openExternal).toHaveBeenCalledTimes(1);
      expect(electronMocks.openExternal).toHaveBeenLastCalledWith(fullAuthUrl);

      reopenOauthLogin();
      expect(electronMocks.openExternal).toHaveBeenCalledTimes(2);
      expect(electronMocks.openExternal).toHaveBeenLastCalledWith(fullAuthUrl);

      loginOutcome.reject(new Error(upstreamError));
      await running;
      const errorEvent = events.find((event) => event.type === 'error');
      expect(errorEvent?.message.length).toBeLessThanOrEqual(300);
      expect(errorEvent?.message).not.toContain('ya29.secret');

      reopenOauthLogin();
      expect(electronMocks.openExternal).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock('@earendil-works/pi-coding-agent');
      vi.resetModules();
    }
  });
});
