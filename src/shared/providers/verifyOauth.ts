/** 验收桩：只在 ENSO_VERIFY=1 且未打包时由 Main 注册。authorize/token 指向 ENSO_VERIFY_OAUTH_BASE。 */
import { randomBytes } from 'node:crypto';
import { startOauthCallbackServer, waitForOauthCallbackCode } from './callbackServer';
import {
  createEventStream,
  type PiEventStream,
  type PiLoginCallbacks,
  type ProviderConfigInput,
} from './piProviderTypes';

export const VERIFY_OAUTH_PROVIDER_ID = '__verify__';
export const VERIFY_DEVICE_PROVIDER_ID = '__verify-device__';
export const VERIFY_DEVICE_USER_CODE = 'WXYZ-1234';

const VERIFY_API = 'verify-oauth';
const VERIFY_MODEL = {
  id: 'verify-stub',
  name: 'Verify Stub',
  reasoning: false,
  input: ['text'] as ('text' | 'image')[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_000,
  maxTokens: 1_024,
};

function verifyOauthBase(): string {
  const raw = process.env.ENSO_VERIFY_OAUTH_BASE?.trim();
  if (!raw) throw new Error('ENSO_VERIFY_OAUTH_BASE is not set');
  return raw.replace(/\/+$/, '');
}

function verifyOauthEnabled(isPackaged: boolean): boolean {
  return process.env.ENSO_VERIFY === '1' && !isPackaged;
}

async function exchangeVerifyCode(
  base: string,
  code: string,
  state: string,
  signal?: AbortSignal
): Promise<{ access: string; refresh: string; expires: number }> {
  const response = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, state }),
    signal,
  });
  if (!response.ok) throw new Error(`verify oauth token endpoint returned ${response.status}`);
  const data = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('verify oauth token endpoint returned no access token');
  }
  if (typeof data.refresh_token !== 'string' || !data.refresh_token) {
    throw new Error('verify oauth token endpoint returned no refresh token');
  }
  const expiresIn =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
      ? data.expires_in
      : 3600;
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + expiresIn * 1000,
  };
}

async function loginWithCallback(callbacks: PiLoginCallbacks) {
  const base = verifyOauthBase();
  const state = randomBytes(16).toString('hex');
  const server = await startOauthCallbackServer({
    preferredPort: 0,
    callbackPath: '/callback',
    expectedState: state,
    signal: callbacks.signal,
    onProgress: callbacks.onProgress,
  });
  try {
    const params = new URLSearchParams({
      client_id: 'enso-verify',
      response_type: 'code',
      redirect_uri: server.redirectUri,
      state,
    });
    callbacks.onAuth({
      url: `${base}/authorize?${params.toString()}`,
      instructions: 'Complete authorization in your browser',
    });
    callbacks.onProgress?.('Waiting for browser authentication...');
    const code = await waitForOauthCallbackCode(
      server,
      (request) => callbacks.onPrompt(request as Parameters<PiLoginCallbacks['onPrompt']>[0]),
      callbacks.signal
    );
    callbacks.onProgress?.('Exchanging authorization code for tokens...');
    return exchangeVerifyCode(base, code, state, callbacks.signal);
  } finally {
    server.close();
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('登录已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('登录已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function loginWithDevice(callbacks: PiLoginCallbacks) {
  const base = verifyOauthBase();
  callbacks.onDeviceCode({
    userCode: VERIFY_DEVICE_USER_CODE,
    verificationUri: `${base}/device`,
  });
  callbacks.onProgress?.('Enter the code in your browser');
  const deadline = Date.now() + 300_000;
  while (!callbacks.signal?.aborted) {
    if (Date.now() > deadline) throw new Error('verify device confirmation timed out');
    const response = await fetch(`${base}/device/poll?user_code=${VERIFY_DEVICE_USER_CODE}`, {
      signal: callbacks.signal,
    });
    if (response.ok) {
      const data = (await response.json()) as {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
      };
      if (typeof data.access_token === 'string' && typeof data.refresh_token === 'string') {
        const expiresIn =
          typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
            ? data.expires_in
            : 3600;
        return {
          access: data.access_token,
          refresh: data.refresh_token,
          expires: Date.now() + expiresIn * 1000,
        };
      }
    }
    await delay(500, callbacks.signal);
  }
  throw new Error('登录已取消');
}

function streamVerify(): PiEventStream {
  return createEventStream();
}

function provider(
  name: string,
  login: (
    callbacks: PiLoginCallbacks
  ) => Promise<{ access: string; refresh: string; expires: number }>
): ProviderConfigInput {
  return {
    name,
    api: VERIFY_API,
    baseUrl: 'http://127.0.0.1',
    models: [VERIFY_MODEL],
    streamSimple: streamVerify as unknown as ProviderConfigInput['streamSimple'],
    oauth: {
      name,
      isSubscription: true,
      login,
      refreshToken: async (credentials) => credentials,
      getApiKey: (credentials) => credentials.access,
    },
  };
}

/** 未开启时返回空列表，正常模式的订阅目录里不会出现这两个 id。 */
export function verifyOauthProviders(isPackaged: boolean): Array<[string, ProviderConfigInput]> {
  if (!verifyOauthEnabled(isPackaged)) return [];
  return [
    [VERIFY_OAUTH_PROVIDER_ID, provider('Verify OAuth', loginWithCallback)],
    [VERIFY_DEVICE_PROVIDER_ID, provider('Verify Device', loginWithDevice)],
  ];
}
