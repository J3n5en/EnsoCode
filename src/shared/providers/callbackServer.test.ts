import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { startOauthCallbackServer } from './callbackServer';

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
});
