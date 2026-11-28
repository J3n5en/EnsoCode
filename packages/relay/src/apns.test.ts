import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApnsEnv, handleApnsPush, resetApnsJwtCache, vapidKeyHash } from './apns';

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toPkcs8Pem(buf: ArrayBuffer): string {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  const b64 = btoa(bin)
    .match(/.{1,64}/g)!
    .join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}

async function makeEcKeyPair() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(
    (await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer
  );
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', kp.privateKey)) as ArrayBuffer;
  return { kp, rawPub, pubB64Url: b64url(rawPub), pem: toPkcs8Pem(pkcs8) };
}

async function signVapidHeader(
  kp: CryptoKeyPair,
  pubB64Url: string,
  aud: string,
  expSec: number
): Promise<string> {
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64url(enc.encode(JSON.stringify({ aud, exp: expSec, sub: 'https://enso.test' })));
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      kp.privateKey,
      enc.encode(`${h}.${p}`)
    )
  );
  return `vapid t=${h}.${p}.${b64url(sig)}, k=${pubB64Url}`;
}

describe('CF APNs E2E 推送网关', () => {
  const tokenHex = 'a1'.repeat(32);
  const nowMs = 1_760_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);

  beforeEach(() => {
    resetApnsJwtCache();
  });

  it('校验 VAPID 签名与公钥指纹后，原样透传 aes128gcm 密文给 APNs 并返回 201', async () => {
    const apnsKey = await makeEcKeyPair();
    const vapidKey = await makeEcKeyPair();
    const kHash = await vapidKeyHash(vapidKey.rawPub);
    const authHeader = await signVapidHeader(
      vapidKey.kp,
      vapidKey.pubB64Url,
      'https://enso-relay.j3.do',
      nowSec + 3600
    );

    const seenCalls: { url: string; init: RequestInit }[] = [];
    const env: ApnsEnv = {
      APNS_PRIVATE_KEY: apnsKey.pem,
      APNS_KEY_ID: 'KEY1234567',
      APNS_TEAM_ID: '69GW9UBCN2',
      APNS_TOPIC: 'com.j3n5en.ensocode',
      APNS_FETCH: vi.fn(async (input, init) => {
        seenCalls.push({ url: String(input), init: init ?? {} });
        return new Response(null, { status: 200 });
      }),
    };

    const ciphertext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const req = new Request(`https://enso-relay.j3.do/v1/push/apns/prod/${tokenHex}?k=${kHash}`, {
      method: 'POST',
      headers: {
        authorization: authHeader,
        'content-encoding': 'aes128gcm',
        ttl: '1800',
      },
      body: ciphertext,
    });

    const res = await handleApnsPush(req, env, 'prod', tokenHex, nowMs);
    expect(res.status).toBe(201);
    expect(seenCalls).toHaveLength(1);
    expect(seenCalls[0].url).toBe(`https://api.push.apple.com/3/device/${tokenHex}`);
    const headers = seenCalls[0].init.headers as Record<string, string>;
    expect(headers['apns-topic']).toBe('com.j3n5en.ensocode');
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-expiration']).toBe(String(nowSec + 1800));
    expect(headers.authorization.startsWith('bearer ')).toBe(true);

    const apnsPayload = JSON.parse(String(seenCalls[0].init.body)) as {
      aps: { 'mutable-content': number };
      enso: { c: string };
    };
    expect(apnsPayload.aps['mutable-content']).toBe(1);
    expect(apnsPayload.enso.c).toBe(btoa(String.fromCharCode(...ciphertext)));

    // 第二次在 45 分钟内复用 APNs JWT
    const res2 = await handleApnsPush(
      new Request(`https://enso-relay.j3.do/v1/push/apns/prod/${tokenHex}?k=${kHash}`, {
        method: 'POST',
        headers: { authorization: authHeader, 'content-encoding': 'aes128gcm' },
        body: ciphertext,
      }),
      env,
      'prod',
      tokenHex,
      nowMs + 10 * 60_000
    );
    expect(res2.status).toBe(201);
    const headers2 = seenCalls[1].init.headers as Record<string, string>;
    expect(headers2.authorization).toBe(headers.authorization);
  });

  it('拒绝错误公钥指纹、过期 JWT 或错误 aud，防止任意方滥用 device token', async () => {
    const apnsKey = await makeEcKeyPair();
    const vapidKey = await makeEcKeyPair();
    const otherKey = await makeEcKeyPair();
    const kHash = await vapidKeyHash(vapidKey.rawPub);
    const fetchSpy = vi.fn();
    const env: ApnsEnv = {
      APNS_PRIVATE_KEY: apnsKey.pem,
      APNS_KEY_ID: 'KEY1234567',
      APNS_TEAM_ID: '69GW9UBCN2',
      APNS_FETCH: fetchSpy,
    };

    // 1. 公钥不匹配
    const otherAuth = await signVapidHeader(
      otherKey.kp,
      otherKey.pubB64Url,
      'https://enso-relay.j3.do',
      nowSec + 3600
    );
    const r1 = await handleApnsPush(
      new Request(`https://enso-relay.j3.do/v1/push/apns/prod/${tokenHex}?k=${kHash}`, {
        method: 'POST',
        headers: { authorization: otherAuth, 'content-encoding': 'aes128gcm' },
        body: new Uint8Array([1, 2, 3]),
      }),
      env,
      'prod',
      tokenHex,
      nowMs
    );
    expect(r1.status).toBe(403);

    // 2. 过期 JWT
    const expiredAuth = await signVapidHeader(
      vapidKey.kp,
      vapidKey.pubB64Url,
      'https://enso-relay.j3.do',
      nowSec - 120
    );
    const r2 = await handleApnsPush(
      new Request(`https://enso-relay.j3.do/v1/push/apns/prod/${tokenHex}?k=${kHash}`, {
        method: 'POST',
        headers: { authorization: expiredAuth, 'content-encoding': 'aes128gcm' },
        body: new Uint8Array([1, 2, 3]),
      }),
      env,
      'prod',
      tokenHex,
      nowMs
    );
    expect(r2.status).toBe(401);

    // 3. aud 不匹配
    const badAudAuth = await signVapidHeader(
      vapidKey.kp,
      vapidKey.pubB64Url,
      'https://evil.example.com',
      nowSec + 3600
    );
    const r3 = await handleApnsPush(
      new Request(`https://enso-relay.j3.do/v1/push/apns/prod/${tokenHex}?k=${kHash}`, {
        method: 'POST',
        headers: { authorization: badAudAuth, 'content-encoding': 'aes128gcm' },
        body: new Uint8Array([1, 2, 3]),
      }),
      env,
      'prod',
      tokenHex,
      nowMs
    );
    expect(r3.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('APNs 返回 BadDeviceToken/410 映射为 410，且支持 sandbox 与 liveactivity 预留路由', async () => {
    const apnsKey = await makeEcKeyPair();
    const vapidKey = await makeEcKeyPair();
    const kHash = await vapidKeyHash(vapidKey.rawPub);
    const authHeader = await signVapidHeader(
      vapidKey.kp,
      vapidKey.pubB64Url,
      'https://enso-relay.j3.do',
      nowSec + 3600
    );

    let lastUrl = '';
    let lastHeaders: Record<string, string> = {};
    const env: ApnsEnv = {
      APNS_PRIVATE_KEY: apnsKey.pem,
      APNS_KEY_ID: 'KEY1234567',
      APNS_TEAM_ID: '69GW9UBCN2',
      APNS_FETCH: vi.fn(async (input, init) => {
        lastUrl = String(input);
        lastHeaders = (init?.headers ?? {}) as Record<string, string>;
        if (lastHeaders['apns-push-type'] === 'liveactivity') {
          return new Response(null, { status: 200 });
        }
        return Response.json({ reason: 'BadDeviceToken' }, { status: 400 });
      }),
    };

    const r1 = await handleApnsPush(
      new Request(`https://enso-relay.j3.do/v1/push/apns/sandbox/${tokenHex}?k=${kHash}`, {
        method: 'POST',
        headers: { authorization: authHeader, 'content-encoding': 'aes128gcm' },
        body: new Uint8Array([9, 8, 7]),
      }),
      env,
      'sandbox',
      tokenHex,
      nowMs
    );
    expect(r1.status).toBe(410);
    expect(lastUrl).toBe(`https://api.sandbox.push.apple.com/3/device/${tokenHex}`);

    const r2 = await handleApnsPush(
      new Request(
        `https://enso-relay.j3.do/v1/push/apns/prod/${tokenHex}?k=${kHash}&type=liveactivity`,
        {
          method: 'POST',
          headers: { authorization: authHeader, 'content-type': 'application/json' },
          body: JSON.stringify({
            aps: { timestamp: nowSec, event: 'update', 'content-state': { status: 'running' } },
          }),
        }
      ),
      env,
      'prod',
      tokenHex,
      nowMs
    );
    expect(r2.status).toBe(201);
    expect(lastHeaders['apns-push-type']).toBe('liveactivity');
    expect(lastHeaders['apns-topic']).toBe('com.j3n5en.ensocode.push-type.liveactivity');
  });
});
