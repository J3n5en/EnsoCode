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

export interface OauthCallbackServer {
  /** 实际生效的 redirect_uri（端口被占用时会退到随机端口） */
  redirectUri: string;
  /** 等浏览器带 code 回来；用户拒绝、超时、取消或主动关闭会 reject */
  waitForCode: () => Promise<string>;
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

  const { promise, resolve, reject } = Promise.withResolvers<string>();
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
    const url = new URL(req.url ?? '/', redirectUri);
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

    res.writeHead(isSuccess ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(isSuccess ? SUCCESS_HTML : FAILURE_HTML);

    if (isSuccess) {
      settle(() => resolve(code));
      return;
    }
    if (error === 'access_denied' && isValidState) {
      settle(() => reject(new Error(`授权被拒绝：${error}`)));
    }
  });

  return {
    redirectUri,
    waitForCode: () => promise,
    close: () => {
      settle(() => reject(new Error('回调服务器已关闭')));
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      server.closeAllConnections();
      server.close();
    },
  };
}
