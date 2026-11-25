import http from 'node:http';
import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import {
  OAUTH_MANUAL_PASTE_MESSAGE,
  oauthManualPasteRejection,
  parseManualOauthInput,
  startOauthCallbackServer,
  waitForOauthCallbackCode,
} from './callbackServer';

const start = (timeoutMs: number) =>
  startOauthCallbackServer({
    preferredPort: 0,
    callbackPath: '/oauth-callback',
    expectedState: 'expected-state',
    timeoutMs,
  });

/** fetch 会规范化路径，这里用 http.request 原样发出请求行；挂住不回视为 timeout */
function rawGet(redirectUri: string, path: string): Promise<number | 'timeout'> {
  const { promise, resolve } = Promise.withResolvers<number | 'timeout'>();
  const req = http.request(
    { host: '127.0.0.1', port: Number(new URL(redirectUri).port), path },
    (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }
  );
  req.setTimeout(1_000, () => {
    resolve('timeout');
    req.destroy();
  });
  req.on('error', () => resolve('timeout'));
  req.end();
  return promise;
}

const expectManual = {
  port: 59653,
  callbackPath: '/callback',
  expectedState: 'expected-state',
};
const secret = 'super-secret-code';

describe('parseManualOauthInput', () => {
  it('接受这次回调的 localhost / 127.0.0.1 完整链接，以及 code#state', () => {
    const query = `code=${secret}&state=expected-state`;
    expect(parseManualOauthInput(`http://127.0.0.1:59653/callback?${query}`, expectManual)).toEqual(
      { ok: true, code: secret }
    );
    expect(parseManualOauthInput(`http://localhost:59653/callback?${query}`, expectManual)).toEqual(
      { ok: true, code: secret }
    );
    expect(parseManualOauthInput(`${secret}#expected-state`, expectManual)).toEqual({
      ok: true,
      code: secret,
    });
  });

  it('按 host / port / path / state / 缺 code / 垃圾输入拒绝，原因里不出现 code', () => {
    const cases: Array<[string, string]> = [
      [`https://127.0.0.1:59653/callback?code=${secret}&state=expected-state`, 'host'],
      [`http://evil.test:59653/callback?code=${secret}&state=expected-state`, 'host'],
      [`http://127.0.0.1:9/callback?code=${secret}&state=expected-state`, 'port'],
      [`http://127.0.0.1:59653/other?code=${secret}&state=expected-state`, 'path'],
      [`http://127.0.0.1:59653/callback?code=${secret}&state=wrong`, 'state'],
      ['http://127.0.0.1:59653/callback?state=expected-state', 'code'],
      [`${secret}#wrong`, 'state'],
      ['not a url', 'not-a-url'],
    ];
    for (const [input, reason] of cases) {
      const parsed = parseManualOauthInput(input, expectManual);
      expect(parsed).toEqual({ ok: false, reason });
      expect(JSON.stringify(parsed)).not.toContain(secret);
    }
  });

  it('粘贴提示和拒绝文案都有中文译文，且拒绝文案不携带用户输入', () => {
    expect(zhTranslations[OAUTH_MANUAL_PASTE_MESSAGE]).toBeTruthy();
    for (const reason of ['host', 'port', 'path', 'state', 'code', 'not-a-url']) {
      const message = oauthManualPasteRejection(reason);
      expect(zhTranslations[message]).toBeTruthy();
      expect(message).not.toContain(secret);
    }
    expect(zhTranslations[oauthManualPasteRejection('state')]).toBe(
      '链接与本次授权不匹配，请重新复制最新的地址'
    );
    for (const reason of ['host', 'port', 'path', 'not-a-url']) {
      expect(zhTranslations[oauthManualPasteRejection(reason)]).toBe('这不是授权回调地址');
    }
    // 已用过的码走 settled 成功消费，没有单独的「已使用」拒绝
    expect(zhTranslations[oauthManualPasteRejection('code')]).not.toContain('已使用');
  });
});

describe('startOauthCallbackServer', () => {
  // 登录等待期间任何网页都能请求本机回调端口；`//` 会让 new URL 抛错，修复前是 Main 里的未捕获异常，
  // 请求也一直挂着不回
  it('解析不了的请求路径回 400 而不抛异常，之后合法回调仍能完成登录', async () => {
    const server = await start(5_000);
    try {
      expect(await rawGet(server.redirectUri, '//')).toBe(400);
      const valid = await fetch(`${server.redirectUri}?code=good&state=expected-state`);
      expect(valid.status).toBe(200);
      await expect(server.waitForCode()).resolves.toBe('good');
    } finally {
      server.close();
    }
  });

  // 授权服务器带回 invalid_scope 等错误时登录已无法继续；修复前只认 access_denied，其余干等到超时
  it('state 合法的任意授权错误立即结束等待并回错误页，state 不符的错误不影响等待', async () => {
    const server = await start(1_000);
    const result = server.waitForCode().then(
      () => 'resolved',
      (error: Error) => error.message
    );
    try {
      const forged = await fetch(`${server.redirectUri}?error=server_error&state=wrong-state`);
      expect(forged.status).toBe(400);
      const response = await fetch(
        `${server.redirectUri}?error=invalid_scope&state=expected-state`
      );
      expect(response.status).toBe(400);
      await expect(result).resolves.toBe('授权失败：invalid_scope');
      expect(await response.text()).toContain('授权未完成');
    } finally {
      server.close();
    }
  });

  it('手动粘贴通过后 waitForCode 兑现同一个 code，第二次提交被拒绝', async () => {
    const server = await start(5_000);
    const pending = server.waitForCode();
    try {
      const port = Number(new URL(server.redirectUri).port);
      const pasted = `http://localhost:${port}/oauth-callback?code=${secret}&state=expected-state`;
      expect(server.submitManualInput(pasted)).toEqual({ accepted: true });
      await expect(pending).resolves.toBe(secret);
      expect(server.submitManualInput(pasted)).toEqual({ accepted: false, reason: 'settled' });
      await expect(server.waitForCode()).resolves.toBe(secret);
    } finally {
      server.close();
    }
  });

  it('拒绝后重提示带上原因，粘贴指引不变；接受后不再提示', async () => {
    const server = await start(5_000);
    const port = Number(new URL(server.redirectUri).port);
    const wrongState = `http://127.0.0.1:${port}/oauth-callback?code=${secret}&state=wrong`;
    const accepted = `http://127.0.0.1:${port}/oauth-callback?code=${secret}&state=expected-state`;
    const answers = ['not a url', wrongState, accepted];
    const seen: Array<{ message: string; error?: string }> = [];
    try {
      const code = await waitForOauthCallbackCode(server, async (request) => {
        seen.push({ message: request.message, error: request.error });
        const next = answers.shift();
        if (next === undefined) throw new Error('unexpected extra prompt');
        return next;
      });
      expect(code).toBe(secret);
      expect(seen.map((item) => item.message)).toEqual([
        OAUTH_MANUAL_PASTE_MESSAGE,
        OAUTH_MANUAL_PASTE_MESSAGE,
        OAUTH_MANUAL_PASTE_MESSAGE,
      ]);
      expect(seen.map((item) => item.error)).toEqual([
        undefined,
        oauthManualPasteRejection('not-a-url'),
        oauthManualPasteRejection('state'),
      ]);
    } finally {
      server.close();
    }
  });
});
