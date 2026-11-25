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
  /**
   * 远程浏览器到不了 loopback 时，把地址栏完整链接或 `code#state` 交进来。
   * 校验通过后与浏览器回调走同一条 settle；已结束再交会被拒绝。
   */
  submitManualInput(input: string): { accepted: true } | { accepted: false; reason: string };
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

export type ManualOauthRejectReason = 'host' | 'port' | 'path' | 'state' | 'code' | 'not-a-url';

export type ParsedManualOauthInput =
  | { ok: true; code: string }
  | { ok: false; reason: ManualOauthRejectReason };

export interface ManualOauthExpect {
  port: number;
  callbackPath: string;
  expectedState: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** 授权完成后引导用户把打不开的 localhost 地址贴回来。经 t() 显示，译文在 i18n 表。 */
export const OAUTH_MANUAL_PASTE_MESSAGE =
  'After you authorize, the browser opens a localhost page that will not load. Paste the full address from the address bar here.';

/** 粘贴被拒时显示在输入框下的原因。不要把用户粘贴的内容拼进来，里面有 code。 */
export function oauthManualPasteRejection(reason: string): string {
  switch (reason) {
    case 'state':
      return 'The link does not match this authorization. Copy the latest address again.';
    case 'code':
      return 'That input has no authorization code. Paste the full localhost address from the address bar.';
    default:
      return 'That is not an authorization callback address.';
  }
}

/**
 * 解析用户粘贴的授权输入。只接受这次回调服务器的 http loopback，或 Anthropic 的 `code#state`。
 * 失败原因是枚举，调用方自己写提示，避免 code 进日志。
 */
export function parseManualOauthInput(
  input: string,
  expected: ManualOauthExpect
): ParsedManualOauthInput {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'not-a-url' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return parseManualOauthUrl(trimmed, expected);
  return parseManualCodeState(trimmed, expected.expectedState);
}

function parseManualOauthUrl(input: string, expected: ManualOauthExpect): ParsedManualOauthInput {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'not-a-url' };
  }
  if (url.protocol !== 'http:') return { ok: false, reason: 'host' };
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return { ok: false, reason: 'host' };
  const port = url.port === '' ? 80 : Number(url.port);
  if (!Number.isInteger(port) || port !== expected.port) return { ok: false, reason: 'port' };
  if (url.pathname !== expected.callbackPath) return { ok: false, reason: 'path' };
  if (url.searchParams.get('state') !== expected.expectedState)
    return { ok: false, reason: 'state' };
  const code = url.searchParams.get('code');
  if (!code) return { ok: false, reason: 'code' };
  return { ok: true, code };
}

function parseManualCodeState(input: string, expectedState: string): ParsedManualOauthInput {
  const hash = input.indexOf('#');
  if (hash <= 0) return { ok: false, reason: hash === 0 ? 'code' : 'not-a-url' };
  const code = input.slice(0, hash);
  const state = input.slice(hash + 1);
  if (state !== expectedState) return { ok: false, reason: 'state' };
  return { ok: true, code };
}

export interface OauthManualPromptRequest {
  type: 'manual_code';
  message: string;
  /** 上一轮粘贴被拒的原因。首轮没有。message 始终是粘贴指引。 */
  error?: string;
  placeholder?: string;
  signal: AbortSignal;
}

/**
 * 浏览器回调与手动粘贴竞速。回调先到就 abort 手动提示。
 * pi 把扩展 onPrompt 适配成 `{ type: 'text', ...prompt }`，调用方要把 type 和 signal
 * 放进 onPrompt 参数，后写字段才会盖掉 text，提示才能单独取消。
 */
export async function waitForOauthCallbackCode(
  server: OauthCallbackServer,
  prompt: (request: OauthManualPromptRequest) => Promise<string>,
  signal?: AbortSignal
): Promise<string> {
  const placeholder = `${server.redirectUri}?code=...&state=...`;
  let rejection: string | undefined;
  const callback = server.waitForCode().then(
    (code) => ({ won: 'callback' as const, code }),
    (error: unknown) => ({ won: 'callback-error' as const, error })
  );

  for (;;) {
    if (signal?.aborted) throw new Error('登录已取消');
    const manualAbort = new AbortController();
    const request: OauthManualPromptRequest = {
      type: 'manual_code',
      message: OAUTH_MANUAL_PASTE_MESSAGE,
      placeholder,
      signal: manualAbort.signal,
      ...(rejection ? { error: rejection } : {}),
    };
    const manual = Promise.resolve()
      .then(() => prompt(request))
      .then(
        (input) => ({ won: 'manual' as const, input }),
        (error: unknown) => ({ won: 'manual-error' as const, error })
      );
    const winner = await Promise.race([callback, manual]);
    if (winner.won === 'callback') {
      manualAbort.abort();
      return winner.code;
    }
    if (winner.won === 'callback-error') {
      manualAbort.abort();
      throw winner.error;
    }
    if (winner.won === 'manual-error') {
      throw winner.error instanceof Error ? winner.error : new Error('登录已取消');
    }
    const submitted = server.submitManualInput(winner.input);
    if (submitted.accepted || submitted.reason === 'settled') {
      const settled = await callback;
      if (settled.won === 'callback-error') throw settled.error;
      return settled.code;
    }
    rejection = oauthManualPasteRejection(submitted.reason);
  }
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
    submitManualInput: (input: string) => {
      if (settled) return { accepted: false, reason: 'settled' };
      const parsed = parseManualOauthInput(input, {
        port,
        callbackPath: options.callbackPath,
        expectedState: options.expectedState,
      });
      if (!parsed.ok) return { accepted: false, reason: parsed.reason };
      let won = false;
      settle(() => {
        won = true;
        response.resolve({ code: parsed.code });
        codeOnly.resolve(parsed.code);
      });
      return won ? { accepted: true } : { accepted: false, reason: 'settled' };
    },
    close: () => {
      settle(() => reject(new Error('回调服务器已关闭')));
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      server.closeAllConnections();
      server.close();
    },
  };
}
