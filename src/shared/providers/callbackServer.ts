/**
 * OAuth 回调服务器（loopback）。
 *
 * 用 `node:http`（`http.createServer` + `res.writeHead/res.end`）实现的 loopback
 * OAuth 回调服务器。端口从 `server.address()` 读回，关闭走 `close()` +
 * `closeAllConnections()`（对应 Bun `server.stop()` 默认断掉在途连接的行为；
 * Electron 主进程没有 Bun，所以不能用 `Bun.serve`）。
 *
 * 不启用 IPv6 双栈伴随监听：Google 的 installed-app 回调固定发到
 * `http://127.0.0.1:<port>`，只需要 IPv4 loopback 一条。
 */
import http from 'node:http';

const LOOPBACK_HOST = '127.0.0.1';
/** 等浏览器回调的上限 */
const DEFAULT_WAIT_MS = 300_000;

const SUCCESS_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>登录完成</title><style>body{font-family:system-ui,-apple-system,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
background:#0f1115;color:#e6e6e6}div{text-align:center}</style></head>
<body><div><h2>登录完成</h2><p>可以关闭此页面，回到应用继续。</p></div></body></html>`;

const FAILURE_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>登录失败</title><style>body{font-family:system-ui,-apple-system,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
background:#0f1115;color:#e6e6e6}div{text-align:center}</style></head>
<body><div><h2>登录失败</h2><p>回调参数不合法，请回到应用重试。</p></div></body></html>`;

/** 授权服务器带回 error 时的页面；不回显 error 原文，免得在本机回调源上反射任意内容 */
const ERROR_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>授权未完成</title><style>body{font-family:system-ui,-apple-system,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
background:#0f1115;color:#e6e6e6}div{text-align:center}</style></head>
<body><div><h2>授权未完成</h2><p>授权服务器返回了错误，请回到应用查看原因后重试。</p></div></body></html>`;

export interface OauthCallbackServer {
  /** 实际生效的 redirect_uri（端口被占用时会退到随机端口） */
  redirectUri: string;
  /** 等浏览器带 code 回来；用户拒绝、超时、取消或主动关闭会 reject */
  waitForCode: () => Promise<string>;
  /** 同 waitForCode，另带授权响应里的 iss（RFC 9207，供调用方核对授权服务器） */
  waitForResponse: () => Promise<{ code: string; iss?: string }>;
  close: () => void;
}

export interface OauthCallbackServerOptions {
  preferredPort: number;
  callbackPath: string;
  /** 授权请求里带出去的 state，回调时逐字比对，防 CSRF */
  expectedState: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 首选端口被占用、退到随机端口时的告知 */
  onProgress?: (message: string) => void;
}

function listen(port: number): Promise<http.Server> {
  const server = http.createServer();
  const { promise, resolve, reject } = Promise.withResolvers<http.Server>();
  const onError = (error: Error) => {
    server.close();
    reject(error);
  };
  server.once('error', onError);
  server.listen(port, LOOPBACK_HOST, () => {
    server.removeListener('error', onError);
    resolve(server);
  });
  return promise;
}

export async function startOauthCallbackServer(
  options: OauthCallbackServerOptions
): Promise<OauthCallbackServer> {
  let server: http.Server;
  try {
    server = await listen(options.preferredPort);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') throw error;
    // Google 的 loopback 重定向不校验端口，占用时退到随机端口即可继续
    server = await listen(0);
    const address = server.address();
    const actual = typeof address === 'object' && address ? address.port : 0;
    options.onProgress?.(`端口 ${options.preferredPort} 被占用，改用 ${actual}`);
  }

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.preferredPort;
  const redirectUri = `http://${LOOPBACK_HOST}:${port}${options.callbackPath}`;

  // 两个出口各自同步落定（不经 then 派生），调用方只等其一，另一个预挂空 catch 防无人接管的 rejection
  const response = Promise.withResolvers<{ code: string; iss?: string }>();
  const codeOnly = Promise.withResolvers<string>();
  response.promise.catch(() => {});
  codeOnly.promise.catch(() => {});
  const reject = (error: Error) => {
    response.reject(error);
    codeOnly.reject(error);
  };
  let settled = false;
  const settle = (action: () => void) => {
    if (settled) return;
    settled = true;
    action();
  };

  const timer = setTimeout(
    () => settle(() => reject(new Error('等待浏览器回调超时'))),
    options.timeoutMs ?? DEFAULT_WAIT_MS
  );
  const onAbort = () => settle(() => reject(new Error('登录已取消')));
  options.signal?.addEventListener('abort', onAbort, { once: true });

  server.on('request', (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', redirectUri);
    } catch {
      // 等待期间任何网页都能请求这个端口；`//` 之类解析失败若抛出，就是 Main 里的未捕获异常
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }
    if (url.pathname !== options.callbackPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const isValidState = state === options.expectedState;
    const isSuccess = !error && !!code && isValidState;
    // state 不符的 error 可能是伪造的，不能借它中断真实登录
    const isAuthError = !!error && isValidState;

    res.writeHead(isSuccess ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(isSuccess ? SUCCESS_HTML : isAuthError ? ERROR_HTML : FAILURE_HTML);

    if (isSuccess) {
      const iss = url.searchParams.get('iss');
      settle(() => {
        response.resolve({ code, ...(iss ? { iss } : {}) });
        codeOnly.resolve(code);
      });
      return;
    }
    // invalid_scope 等错误同样意味着这次授权已无法继续，不能让用户干等到超时
    if (isAuthError) {
      const message = error === 'access_denied' ? `授权被拒绝：${error}` : `授权失败：${error}`;
      settle(() => reject(new Error(message)));
    }
  });

  return {
    redirectUri,
    waitForCode: () => codeOnly.promise,
    waitForResponse: () => response.promise,
    close: () => {
      settle(() => reject(new Error('回调服务器已关闭')));
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      server.closeAllConnections();
      server.close();
    },
  };
}
