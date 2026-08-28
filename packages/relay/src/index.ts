import { pairIdFromPublicKey } from './pairing';
import { PairRoom } from './room';

export { PairRoom };

export interface Env {
  PAIR_ROOM: DurableObjectNamespace<PairRoom>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 由 host 公钥算 pairId，把请求（带解析后的 body）转给对应 DO */
async function routeByPublicKey(
  request: Request,
  env: Env,
  internalPath: string
): Promise<Response> {
  let body: { publicKey?: unknown };
  try {
    body = (await request.json()) as { publicKey?: unknown };
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (typeof body.publicKey !== 'string' || !body.publicKey) {
    return json({ error: 'missing publicKey' }, 400);
  }
  const pairId = await pairIdFromPublicKey(body.publicKey);
  const stub = env.PAIR_ROOM.get(env.PAIR_ROOM.idFromName(pairId));
  return stub.fetch(`https://do${internalPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pair-id': pairId },
    body: JSON.stringify(body),
  });
}

/** :id 直接就是 pairId（重连 / 解绑，两端已持有）；转给 DO，保留 method/headers（含 WSS Upgrade） */
function routeById(
  request: Request,
  env: Env,
  pairId: string,
  internalPath: string
): Promise<Response> {
  const stub = env.PAIR_ROOM.get(env.PAIR_ROOM.idFromName(pairId));
  const url = new URL(request.url);
  return stub.fetch(new Request(`https://do${internalPath}${url.search}`, request));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/v1/pair/request' && request.method === 'POST') {
      return routeByPublicKey(request, env, '/request');
    }
    if (path === '/v1/pair/claim' && request.method === 'POST') {
      return routeByPublicKey(request, env, '/claim');
    }

    // /v1/pair/:id  (WSS 连接 或 DELETE 解绑)
    const m = /^\/v1\/pair\/([^/]+)$/.exec(path);
    if (m) {
      const pairId = decodeURIComponent(m[1]);
      if (request.headers.get('Upgrade') === 'websocket') {
        return routeById(request, env, pairId, '/connect');
      }
      if (request.method === 'DELETE') {
        return routeById(request, env, pairId, '/delete');
      }
    }

    return json({ error: 'not found' }, 404);
  },
};
