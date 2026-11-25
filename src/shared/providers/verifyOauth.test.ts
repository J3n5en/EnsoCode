import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { PiLoginCallbacks } from './piProviderTypes';
import {
  VERIFY_DEVICE_PROVIDER_ID,
  VERIFY_DEVICE_USER_CODE,
  VERIFY_OAUTH_PROVIDER_ID,
  verifyOauthProviders,
} from './verifyOauth';

const previousVerify = process.env.ENSO_VERIFY;
const previousBase = process.env.ENSO_VERIFY_OAUTH_BASE;

afterEach(() => {
  if (previousVerify === undefined) delete process.env.ENSO_VERIFY;
  else process.env.ENSO_VERIFY = previousVerify;
  if (previousBase === undefined) delete process.env.ENSO_VERIFY_OAUTH_BASE;
  else process.env.ENSO_VERIFY_OAUTH_BASE = previousBase;
});

describe('verify oauth stub', () => {
  it('只在 ENSO_VERIFY=1 且未打包时注册', () => {
    delete process.env.ENSO_VERIFY;
    expect(verifyOauthProviders(false)).toEqual([]);
    process.env.ENSO_VERIFY = '1';
    expect(verifyOauthProviders(true)).toEqual([]);
    expect(verifyOauthProviders(false).map(([id]) => id)).toEqual([
      VERIFY_OAUTH_PROVIDER_ID,
      VERIFY_DEVICE_PROVIDER_ID,
    ]);
  });

  it('回调粘贴打到本地假 token 端点，设备码轮询确认后给凭据', async () => {
    let tokenBody = '';
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/token') && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          tokenBody = Buffer.concat(chunks).toString('utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'access-v',
              refresh_token: 'refresh-v',
              expires_in: 60,
            })
          );
        });
        return;
      }
      if (req.url?.startsWith('/device/poll')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ access_token: 'access-d', refresh_token: 'refresh-d', expires_in: 60 })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    process.env.ENSO_VERIFY = '1';
    process.env.ENSO_VERIFY_OAUTH_BASE = `http://127.0.0.1:${port}`;
    const providers = verifyOauthProviders(false);
    const callbackLogin = providers[0]?.[1].oauth?.login;
    const deviceLogin = providers[1]?.[1].oauth?.login;
    if (!callbackLogin || !deviceLogin) throw new Error('verify providers missing');

    let redirect = '';
    let state = '';
    const baseCallbacks = {
      onDeviceCode: () => {},
      onSelect: async () => undefined,
      onPrompt: async () => '',
    } satisfies Partial<PiLoginCallbacks>;
    try {
      const pasted = await callbackLogin({
        ...baseCallbacks,
        onAuth: (info) => {
          const url = new URL(info.url);
          expect(url.pathname).toBe('/authorize');
          expect(url.searchParams.get('client_id')).toBe('enso-verify');
          redirect = url.searchParams.get('redirect_uri') ?? '';
          state = url.searchParams.get('state') ?? '';
        },
        onPrompt: async () => `${redirect}?code=verify-code&state=${state}`,
      });
      expect(JSON.parse(tokenBody)).toEqual({ code: 'verify-code', state });
      expect(pasted).toMatchObject({ access: 'access-v', refresh: 'refresh-v' });

      let userCode = '';
      let verification = '';
      const device = await deviceLogin({
        ...baseCallbacks,
        onAuth: () => {},
        onDeviceCode: (info) => {
          userCode = info.userCode;
          verification = info.verificationUri;
        },
      });
      expect(userCode).toBe(VERIFY_DEVICE_USER_CODE);
      expect(verification).toBe(`http://127.0.0.1:${port}/device`);
      expect(device).toMatchObject({ access: 'access-d', refresh: 'refresh-d' });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
