import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAccountProvider } from '../piAccounts';
import {
  installCodexLinkedRefresh,
  parseCodexAuthJson,
  refreshLinkedCodexCredential,
} from './codexAuth';

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
}

const exp = Math.floor(Date.now() / 1000) + 3600;
const access = fakeJwt({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' } });

const codexAuth = (tokens: Record<string, unknown> | undefined, extra?: Record<string, unknown>) =>
  JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens, ...extra });

describe('parseCodexAuthJson', () => {
  it('把 Codex tokens 映射成 pi 的 openai-codex 凭证，expires 取自 access JWT 的 exp', () => {
    const parsed = parseCodexAuthJson(
      codexAuth({ id_token: 'id', access_token: access, refresh_token: 'rt', account_id: 'acct_1' })
    );
    expect(parsed).toEqual({
      status: 'ok',
      credential: {
        type: 'oauth',
        access,
        refresh: 'rt',
        expires: exp * 1000,
        accountId: 'acct_1',
      },
    });
  });

  it('JWT 里没有 chatgpt_account_id 时回退到 tokens.account_id', () => {
    const bare = fakeJwt({ exp });
    const parsed = parseCodexAuthJson(
      codexAuth({ access_token: bare, refresh_token: 'rt', account_id: 'acct_2' })
    );
    expect(parsed.status === 'ok' && parsed.credential.accountId).toBe('acct_2');
  });

  it('JWT 缺 exp 时 expires 为 0，交给 pi 立即刷新', () => {
    const noExp = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' } });
    const parsed = parseCodexAuthJson(
      codexAuth({ access_token: noExp, refresh_token: 'rt', account_id: 'acct_1' })
    );
    expect(parsed.status === 'ok' && parsed.credential.expires).toBe(0);
  });

  it.each([
    ['tokens 缺失（API key 模式）', codexAuth(undefined, { OPENAI_API_KEY: 'sk-x' })],
    ['tokens 为 null', JSON.stringify({ tokens: null })],
    ['refresh_token 为空', codexAuth({ access_token: access, refresh_token: '', account_id: 'a' })],
    ['access_token 缺失', codexAuth({ refresh_token: 'rt', account_id: 'a' })],
  ])('%s → not-logged-in', (_label, raw) => {
    expect(parseCodexAuthJson(raw)).toEqual({ status: 'not-logged-in' });
  });

  it('access 与 tokens 都给不出 accountId 时视为未登录', () => {
    const parsed = parseCodexAuthJson(
      codexAuth({ access_token: fakeJwt({ exp }), refresh_token: 'rt', account_id: '' })
    );
    expect(parsed).toEqual({ status: 'not-logged-in' });
  });

  it.each([
    ['非 JSON', '{not json'],
    ['数组', '[]'],
    ['字符串', '"x"'],
  ])('%s → invalid', (_label, raw) => {
    expect(parseCodexAuthJson(raw)).toEqual({ status: 'invalid' });
  });
});

const nowSec = () => Math.floor(Date.now() / 1000);
const tokenFor = (expSec: number, accountId = 'acct_1') =>
  fakeJwt({ exp: expSec, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } });
const tokenReply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const writeCodexFile = (
  file: string,
  tokens: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) =>
  writeFileSync(
    file,
    JSON.stringify(
      {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens,
        last_refresh: '2026-01-01T00:00:00Z',
        ...extra,
      },
      null,
      2
    )
  );
type FetchMock = ReturnType<typeof vi.fn>;
const sentRefreshTokens = (fetchMock: FetchMock) =>
  fetchMock.mock.calls.map(([, init]) =>
    new URLSearchParams(String((init as RequestInit).body)).get('refresh_token')
  );

describe('refreshLinkedCodexCredential', () => {
  let dir: string;
  let file: string;
  const signal = new AbortController().signal;
  const staleExp = nowSec() + 60;
  const staleAccess = tokenFor(staleExp);
  const stale = {
    type: 'oauth' as const,
    access: staleAccess,
    refresh: 'rt-old',
    expires: staleExp * 1000,
    accountId: 'acct_1',
    codexLinked: true as const,
  };
  const sameAsOurs = {
    id_token: 'id-old',
    access_token: staleAccess,
    refresh_token: 'rt-old',
    account_id: 'acct_1',
  };
  const readCodex = () => JSON.parse(readFileSync(file, 'utf8'));
  const stubFetch = (impl: (...args: unknown[]) => Promise<Response>): FetchMock => {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'enso-codex-link-'));
    file = path.join(dir, 'auth.json');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('Codex 已先刷新：直接沿用它的 token，不再消耗 refresh token', async () => {
    const exp = nowSec() + 3600;
    const fresh = tokenFor(exp);
    writeCodexFile(file, { ...sameAsOurs, access_token: fresh, refresh_token: 'rt-codex' });
    const fetchMock = stubFetch(async () => tokenReply({}));

    await expect(refreshLinkedCodexCredential(stale, signal, file)).resolves.toEqual({
      type: 'oauth',
      access: fresh,
      refresh: 'rt-codex',
      expires: exp * 1000,
      accountId: 'acct_1',
      codexLinked: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('两边 token 相同：由本应用刷新，并按 Codex 格式原子写回、保留其它字段', async () => {
    writeCodexFile(file, sameAsOurs, { extra: 'keep' });
    const exp = nowSec() + 7200;
    const next = tokenFor(exp);
    const fetchMock = stubFetch(async () =>
      tokenReply({
        id_token: 'id-new',
        access_token: next,
        refresh_token: 'rt-new',
        expires_in: 7200,
      })
    );
    const before = Date.now();

    await expect(refreshLinkedCodexCredential(stale, signal, file)).resolves.toEqual({
      type: 'oauth',
      access: next,
      refresh: 'rt-new',
      expires: exp * 1000,
      accountId: 'acct_1',
      codexLinked: true,
    });
    expect(sentRefreshTokens(fetchMock)).toEqual(['rt-old']);
    const saved = readCodex();
    expect(saved).toMatchObject({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      extra: 'keep',
      tokens: {
        id_token: 'id-new',
        access_token: next,
        refresh_token: 'rt-new',
        account_id: 'acct_1',
      },
    });
    expect(Date.parse(saved.last_refresh)).toBeGreaterThanOrEqual(before);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['auth.json']);
  });

  it('刷新响应缺 id_token 时保留 Codex 原有的 id_token', async () => {
    writeCodexFile(file, sameAsOurs);
    stubFetch(async () =>
      tokenReply({
        access_token: tokenFor(nowSec() + 3600),
        refresh_token: 'rt-new',
        expires_in: 3600,
      })
    );

    await refreshLinkedCodexCredential(stale, signal, file);
    expect(readCodex().tokens).toMatchObject({ id_token: 'id-old', refresh_token: 'rt-new' });
  });

  it('Codex 的 token 较新但也快过期：用 Codex 的 refresh token 刷新', async () => {
    writeCodexFile(file, {
      ...sameAsOurs,
      access_token: tokenFor(staleExp + 60),
      refresh_token: 'rt-codex',
    });
    const fetchMock = stubFetch(async () =>
      tokenReply({
        access_token: tokenFor(nowSec() + 3600),
        refresh_token: 'rt-new',
        expires_in: 3600,
      })
    );

    await refreshLinkedCodexCredential(stale, signal, file);
    expect(sentRefreshTokens(fetchMock)).toEqual(['rt-codex']);
    expect(readCodex().tokens.refresh_token).toBe('rt-new');
  });

  it.each([
    [
      'Codex 换了账号',
      () =>
        writeCodexFile(file, {
          access_token: tokenFor(nowSec() + 3600, 'acct_other'),
          refresh_token: 'rt-other',
          account_id: 'acct_other',
        }),
    ],
    ['Codex 文件读不出（正在写或已损坏）', () => writeFileSync(file, '')],
    ['Codex 已登出', () => undefined],
  ])('%s：用自己的 refresh token 刷新，不改写 Codex 文件', async (_label, arrange) => {
    arrange();
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const next = tokenFor(nowSec() + 3600);
    const fetchMock = stubFetch(async () =>
      tokenReply({ access_token: next, refresh_token: 'rt-new', expires_in: 3600 })
    );

    await expect(refreshLinkedCodexCredential(stale, signal, file)).resolves.toMatchObject({
      access: next,
      refresh: 'rt-new',
      codexLinked: true,
    });
    expect(sentRefreshTokens(fetchMock)).toEqual(['rt-old']);
    expect(existsSync(file) ? readFileSync(file, 'utf8') : null).toBe(before);
  });

  it('刷新被拒但 Codex 在此期间已写入新 token：沿用 Codex 的结果', async () => {
    writeCodexFile(file, sameAsOurs);
    const fresh = tokenFor(nowSec() + 3600);
    stubFetch(async () => {
      writeCodexFile(file, { ...sameAsOurs, access_token: fresh, refresh_token: 'rt-codex' });
      return tokenReply({ error: { code: 'refresh_token_reused' } }, 401);
    });

    await expect(refreshLinkedCodexCredential(stale, signal, file)).resolves.toMatchObject({
      access: fresh,
      refresh: 'rt-codex',
      codexLinked: true,
    });
  });

  it('刷新被拒且 Codex 没有新 token：抛错，Codex 文件不动', async () => {
    writeCodexFile(file, sameAsOurs);
    const before = readFileSync(file, 'utf8');
    stubFetch(async () => tokenReply({ error: { code: 'refresh_token_reused' } }, 401));

    await expect(refreshLinkedCodexCredential(stale, signal, file)).rejects.toThrow(/401/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('installCodexLinkedRefresh', () => {
  let dir: string;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('pi 刷新已关联账号时同步 Codex 文件（克隆 key 同样生效），未关联账号仍走 pi 内置刷新', async () => {
    vi.stubEnv('PI_OFFLINE', '1');
    dir = mkdtempSync(path.join(tmpdir(), 'enso-codex-install-'));
    const authFile = path.join(dir, 'pi-auth.json');
    const codexFile = path.join(dir, 'codex-auth.json');
    const expired = (accountId: string) => tokenFor(nowSec() - 10, accountId);
    const linkedAccess = expired('acct_linked');
    writeFileSync(
      authFile,
      JSON.stringify({
        'openai-codex': {
          type: 'oauth',
          access: expired('acct_plain'),
          refresh: 'rt-plain',
          expires: Date.now() - 10_000,
          accountId: 'acct_plain',
        },
        'openai-codex#2': {
          type: 'oauth',
          access: linkedAccess,
          refresh: 'rt-linked',
          expires: Date.now() - 10_000,
          accountId: 'acct_linked',
          codexLinked: true,
        },
      })
    );
    writeCodexFile(codexFile, {
      id_token: 'id-old',
      access_token: linkedAccess,
      refresh_token: 'rt-linked',
      account_id: 'acct_linked',
    });
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const refresh = new URLSearchParams(String(init.body)).get('refresh_token');
      const accountId = refresh === 'rt-linked' ? 'acct_linked' : 'acct_plain';
      return tokenReply({
        id_token: 'id-new',
        access_token: tokenFor(nowSec() + 3600, accountId),
        refresh_token: `${refresh}-next`,
        expires_in: 3600,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = await ModelRuntime.create({
      authPath: authFile,
      modelsPath: null,
      refreshOnCreate: false,
    });

    installCodexLinkedRefresh(runtime, () => codexFile);
    registerAccountProvider(runtime, 'openai-codex#2');
    await runtime.getAuth('openai-codex');
    await runtime.getAuth('openai-codex#2');

    const stored = JSON.parse(readFileSync(authFile, 'utf8'));
    expect(stored['openai-codex']).toMatchObject({ refresh: 'rt-plain-next' });
    expect(stored['openai-codex'].codexLinked).toBeUndefined();
    expect(stored['openai-codex#2']).toMatchObject({
      refresh: 'rt-linked-next',
      codexLinked: true,
    });
    expect(JSON.parse(readFileSync(codexFile, 'utf8')).tokens).toMatchObject({
      id_token: 'id-new',
      refresh_token: 'rt-linked-next',
    });
    expect(sentRefreshTokens(fetchMock).sort()).toEqual(['rt-linked', 'rt-plain']);
  });
});
