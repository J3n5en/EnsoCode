/**
 * APNs 端到端加密推送网关（CF Workers WebCrypto 实现，零外部依赖）：
 * - 接收桌面端 `web-push` 发来的标准 RFC 8291 (`aes128gcm`) 密文 + RFC 8292 VAPID 鉴权头
 * - 严格验证 VAPID ES256 签名、`aud`、`exp` 及 URL `?k=` 公钥指纹，防止 token 被任意滥用
 * - 中继不解密正文，直接将密文封装进 `mutable-content: 1` 的 APNs payload，由 iOS NSE 本地解密
 * - 预留 `?type=liveactivity` 以便后续灵动岛 ActivityKit 远程更新复用同一 APNs 签名器与网关
 */

export interface ApnsEnv {
  APNS_PRIVATE_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  /** 测试注入自定义 APNs fetcher（生产默认全局 fetch，CF Workers 原生 HTTP/2） */
  APNS_FETCH?: typeof fetch;
}

export interface ApnsConfig {
  privateKeyPem: string;
  keyId: string;
  teamId: string;
  topic: string;
}

const DEFAULT_APNS_TOPIC = 'com.j3n5en.ensocode';
const MAX_CIPHERTEXT_BYTES = 3000;
const MAX_LIVE_ACTIVITY_BYTES = 3500;
const APNS_JWT_TTL_MS = 45 * 60_000;
const VAPID_CLOCK_SKEW_SEC = 60;
const VAPID_MAX_EXP_SEC = 24 * 3600 + 60;
const HEX_TOKEN_RE = /^[0-9a-fA-F]{64,256}$/;
const B64URL_RE = /^[A-Za-z0-9_-]{32,128}$/;

export function readApnsConfig(env: ApnsEnv): ApnsConfig | null {
  const privateKeyPem = env.APNS_PRIVATE_KEY?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  if (!privateKeyPem || !keyId || !teamId) return null;
  return {
    privateKeyPem: privateKeyPem.replace(/\\n/g, '\n'),
    keyId,
    teamId,
    topic: env.APNS_TOPIC?.trim() || DEFAULT_APNS_TOPIC,
  };
}

export function isApnsConfigured(env: ApnsEnv): boolean {
  return readApnsConfig(env) !== null;
}

function base64UrlDecode(input: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64Encode(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function parsePemPkcs8(pem: string): Uint8Array | null {
  const stripped = pem
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, '')
    .replace(/-----END [A-Z0-9 ]+-----/g, '')
    .replace(/\s+/g, '');
  if (!stripped) return null;
  try {
    const bin = atob(stripped);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 解析 RFC 8292 `Authorization: vapid t=<jwt>, k=<base64url-pubkey>` */
function parseVapidAuthHeader(header: string | null): { token: string; key: string } | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!/^vapid\s+/i.test(trimmed)) return null;
  const rest = trimmed.replace(/^vapid\s+/i, '');
  let token = '';
  let key = '';
  for (const part of rest.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    const val = part.slice(eq + 1).trim();
    if (name === 't') token = val;
    else if (name === 'k') key = val;
  }
  if (!token || !key) return null;
  return { token, key };
}

function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || url.host;
  const scheme = proto ? `${proto.replace(/:$/, '')}:` : url.protocol;
  return `${scheme}//${host}`;
}

export async function vapidKeyHash(rawPubKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', rawPubKey as BufferSource);
  return base64UrlEncode(new Uint8Array(digest));
}

async function verifyVapid(
  request: Request,
  expectedKeyHash: string,
  nowMs: number
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const parsed = parseVapidAuthHeader(request.headers.get('authorization'));
  if (!parsed) return { ok: false, status: 401, error: 'missing vapid authorization' };

  const rawPub = base64UrlDecode(parsed.key);
  if (rawPub?.length !== 65 || rawPub[0] !== 0x04) {
    return { ok: false, status: 401, error: 'invalid vapid public key' };
  }
  const actualHash = await vapidKeyHash(rawPub);
  if (actualHash !== expectedKeyHash) {
    return { ok: false, status: 403, error: 'vapid key mismatch' };
  }

  const segments = parsed.token.split('.');
  if (segments.length !== 3) return { ok: false, status: 401, error: 'invalid vapid jwt' };
  const [hB64, pB64, sB64] = segments;
  const hBytes = base64UrlDecode(hB64);
  const pBytes = base64UrlDecode(pB64);
  const sigBytes = base64UrlDecode(sB64);
  if (!hBytes || !pBytes || !sigBytes || sigBytes.length !== 64) {
    return { ok: false, status: 401, error: 'invalid vapid jwt encoding' };
  }

  let header: { alg?: unknown };
  let claims: { aud?: unknown; exp?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(hBytes)) as { alg?: unknown };
    claims = JSON.parse(new TextDecoder().decode(pBytes)) as { aud?: unknown; exp?: unknown };
  } catch {
    return { ok: false, status: 401, error: 'invalid vapid jwt json' };
  }
  if (header.alg !== 'ES256') return { ok: false, status: 401, error: 'unsupported vapid alg' };

  const nowSec = Math.floor(nowMs / 1000);
  if (
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    claims.exp < nowSec - VAPID_CLOCK_SKEW_SEC ||
    claims.exp > nowSec + VAPID_MAX_EXP_SEC
  ) {
    return { ok: false, status: 401, error: 'vapid jwt expired' };
  }

  const expectedOrigin = requestOrigin(request);
  if (typeof claims.aud !== 'string' || claims.aud.replace(/\/$/, '') !== expectedOrigin) {
    return { ok: false, status: 401, error: 'vapid aud mismatch' };
  }

  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      rawPub as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const signingInput = new TextEncoder().encode(`${hB64}.${pB64}`);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      sigBytes as BufferSource,
      signingInput
    );
    if (!valid) return { ok: false, status: 401, error: 'invalid vapid signature' };
    return { ok: true };
  } catch {
    return { ok: false, status: 401, error: 'vapid verify failed' };
  }
}

let cachedJwt: { cacheKey: string; token: string; issuedAtMs: number } | null = null;

export function resetApnsJwtCache(): void {
  cachedJwt = null;
}

async function signApnsJwt(config: ApnsConfig, nowMs: number): Promise<string> {
  const cacheKey = `${config.teamId}:${config.keyId}:${config.privateKeyPem.slice(0, 64)}`;
  if (
    cachedJwt &&
    cachedJwt.cacheKey === cacheKey &&
    nowMs - cachedJwt.issuedAtMs < APNS_JWT_TTL_MS
  ) {
    return cachedJwt.token;
  }
  const pkcs8 = parsePemPkcs8(config.privateKeyPem);
  if (!pkcs8) throw new Error('invalid APNS_PRIVATE_KEY pem');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const enc = new TextEncoder();
  const headerB64 = base64UrlEncode(
    enc.encode(JSON.stringify({ alg: 'ES256', kid: config.keyId }))
  );
  const payloadB64 = base64UrlEncode(
    enc.encode(JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }))
  );
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(signingInput)
  );
  const token = `${signingInput}.${base64UrlEncode(new Uint8Array(sigBuf))}`;
  cachedJwt = { cacheKey, token, issuedAtMs: nowMs };
  return token;
}

function parseTtlSeconds(header: string | null): number {
  if (!header) return 3600;
  const parsed = Number.parseInt(header.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 3600;
  return Math.min(parsed, 7 * 86400);
}

const INVALID_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 处理 `POST /v1/push/apns/:env/:token?k=<vapidKeyHash>[&type=alert|liveactivity]`
 */
export async function handleApnsPush(
  request: Request,
  env: ApnsEnv,
  apnsEnv: string,
  deviceToken: string,
  nowMs = Date.now()
): Promise<Response> {
  const config = readApnsConfig(env);
  if (!config) return jsonResponse({ error: 'apns not configured' }, 503);

  if (apnsEnv !== 'prod' && apnsEnv !== 'sandbox') {
    return jsonResponse({ error: 'invalid apns env' }, 400);
  }
  if (!HEX_TOKEN_RE.test(deviceToken)) {
    return jsonResponse({ error: 'invalid device token' }, 400);
  }

  const url = new URL(request.url);
  const expectedHash = url.searchParams.get('k') ?? '';
  if (!B64URL_RE.test(expectedHash)) {
    return jsonResponse({ error: 'missing vapid key hash' }, 400);
  }
  const pushKind = url.searchParams.get('type') || 'alert';
  if (pushKind !== 'alert' && pushKind !== 'liveactivity') {
    return jsonResponse({ error: 'invalid push type' }, 400);
  }

  const auth = await verifyVapid(request, expectedHash, nowMs);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const rawBody = new Uint8Array(await request.arrayBuffer());
  let apnsBody: string;
  let apnsTopic = config.topic;
  let apnsPushType: 'alert' | 'liveactivity' = 'alert';

  if (pushKind === 'liveactivity') {
    if (rawBody.length === 0 || rawBody.length > MAX_LIVE_ACTIVITY_BYTES) {
      return jsonResponse({ error: 'payload out of range' }, rawBody.length === 0 ? 400 : 413);
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(rawBody)) as { aps?: unknown };
      if (!parsed || typeof parsed !== 'object' || typeof parsed.aps !== 'object' || !parsed.aps) {
        return jsonResponse({ error: 'invalid liveactivity payload' }, 400);
      }
      apnsBody = JSON.stringify(parsed);
    } catch {
      return jsonResponse({ error: 'invalid json' }, 400);
    }
    apnsPushType = 'liveactivity';
    apnsTopic = `${config.topic}.push-type.liveactivity`;
  } else {
    const ce = (request.headers.get('content-encoding') ?? '').toLowerCase();
    if (!ce.includes('aes128gcm')) {
      return jsonResponse({ error: 'content-encoding must be aes128gcm' }, 415);
    }
    if (rawBody.length === 0 || rawBody.length > MAX_CIPHERTEXT_BYTES) {
      return jsonResponse({ error: 'payload out of range' }, rawBody.length === 0 ? 400 : 413);
    }
    apnsBody = JSON.stringify({
      aps: {
        'mutable-content': 1,
        alert: { title: 'EnsoCode', body: '收到一条新通知' },
        sound: 'default',
      },
      enso: { c: base64Encode(rawBody) },
    });
  }

  let jwt: string;
  try {
    jwt = await signApnsJwt(config, nowMs);
  } catch {
    return jsonResponse({ error: 'apns signing failed' }, 500);
  }

  const apnsHost =
    apnsEnv === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const ttl = parseTtlSeconds(request.headers.get('ttl'));
  const expiration = ttl === 0 ? 0 : Math.floor(nowMs / 1000) + ttl;
  const fetcher = env.APNS_FETCH ?? fetch;

  let apnsRes: Response;
  try {
    apnsRes = await fetcher(`${apnsHost}/3/device/${deviceToken.toLowerCase()}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${jwt}`,
        'apns-topic': apnsTopic,
        'apns-push-type': apnsPushType,
        'apns-priority': '10',
        'apns-expiration': String(expiration),
        'content-type': 'application/json',
      },
      body: apnsBody,
    });
  } catch {
    return jsonResponse({ error: 'apns upstream unreachable' }, 502);
  }

  if (apnsRes.status === 200) {
    return new Response(null, { status: 201 });
  }

  let reason = '';
  try {
    const errBody = (await apnsRes.json()) as { reason?: unknown };
    if (typeof errBody.reason === 'string') reason = errBody.reason;
  } catch {}

  if (apnsRes.status === 410 || INVALID_TOKEN_REASONS.has(reason)) {
    return jsonResponse({ error: reason || 'unregistered' }, 410);
  }
  if (apnsRes.status === 429) {
    return jsonResponse({ error: reason || 'rate limited' }, 429);
  }
  if (apnsRes.status === 401 || apnsRes.status === 403) {
    return jsonResponse({ error: reason || 'apns auth rejected' }, 502);
  }
  return jsonResponse({ error: reason || `apns status ${apnsRes.status}` }, 502);
}
