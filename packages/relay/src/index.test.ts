import { describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

/** 与真实客户端同格式：32 字节公钥的 base64url（43 字符） */
const VALID_KEY = `${'B'.repeat(42)}A`;

function fakeEnv() {
  const stub = {
    fetch: vi.fn(async () => Response.json({ pairId: 'p', state: 'requested' })),
  };
  const env = {
    PAIR_ROOM: { idFromName: (name: string) => name, get: () => stub },
    ASSETS: { fetch: async () => new Response('asset') },
  } as unknown as Env;
  return { env, stub };
}

function postRequest(publicKey: string): Request {
  return new Request('https://relay/v1/pair/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey }),
  });
}

describe('POST /v1/pair/request 的公钥校验', () => {
  // request 不鉴权且会以 sha256(publicKey) 新建 DO 存储：任意内容都收就能被循环 POST 写满
  it('非真实客户端格式的公钥直接 400，不进 DO', async () => {
    const { env, stub } = fakeEnv();
    for (const publicKey of [
      'abc123',
      'A'.repeat(512 * 1024),
      `${VALID_KEY}A`,
      `+${VALID_KEY.slice(1)}`,
    ]) {
      const res = await worker.fetch(postRequest(publicKey), env);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid publicKey' });
    }
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('真实客户端格式的公钥照常转给 DO', async () => {
    const { env, stub } = fakeEnv();
    const res = await worker.fetch(postRequest(VALID_KEY), env);
    expect(res.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });
});
