import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { claim, MAX_FRAME_BYTES, type PairState, request, tokenValid } from './pairing';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 每个 pairId 一个实例。配对状态 + token 落 ctx.storage（抗 DO 回收，支撑离线重连）；
 * 两个 WebSocket 用 hibernation API 持有（tag = host/guest）。只转发密文，不解密、不写聊天。
 */
export class PairRoom extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === '/request') return this.onRequest(req);
    if (path === '/claim') return this.onClaim(req);
    if (path === '/connect') return this.onConnect(req);
    if (path === '/delete') return this.onDelete();
    return json({ error: 'not found' }, 404);
  }

  /** host 发起 + 轮询：无 state/过期则建 requested；authorized 时回 hostToken + boxedKey */
  private async onRequest(req: Request): Promise<Response> {
    const pairId = req.headers.get('x-pair-id') ?? '';
    const { publicKey } = (await req.json()) as { publicKey: string };
    const prev = await this.ctx.storage.get<PairState>('state');
    const next = request(prev, Date.now(), publicKey);
    if (next !== prev) await this.ctx.storage.put('state', next);
    if (next.phase === 'authorized') {
      return json({
        pairId,
        state: 'authorized',
        hostToken: next.hostToken,
        response: next.boxedKey,
        deviceName: next.deviceName,
      });
    }
    return json({ pairId, state: 'requested' });
  }

  /** 手机认领：一次性，成功回 deviceToken */
  private async onClaim(req: Request): Promise<Response> {
    const pairId = req.headers.get('x-pair-id') ?? '';
    const { boxedKey, deviceName } = (await req.json()) as {
      boxedKey?: string;
      deviceName?: string;
    };
    if (typeof boxedKey !== 'string' || !boxedKey) return json({ error: 'missing boxedKey' }, 400);
    const prev = await this.ctx.storage.get<PairState>('state');
    const res = claim(prev, Date.now(), boxedKey, deviceName?.slice(0, 64) || 'phone');
    if (!res.ok) return json({ error: res.error }, 409);
    await this.ctx.storage.put('state', res.next);
    return json({ pairId, state: 'authorized', deviceToken: res.next.deviceToken });
  }

  /** WSS 进房：校验 token，hibernation accept，通知对端在线状态 */
  private async onConnect(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const role = url.searchParams.get('role');
    const token = url.searchParams.get('token') ?? '';
    if (role !== 'host' && role !== 'guest') return new Response('bad role', { status: 400 });
    const state = await this.ctx.storage.get<PairState>('state');
    if (!tokenValid(state, role, token)) return new Response('unauthorized', { status: 401 });

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [role]);

    if (role === 'host') {
      this.broadcast('guest', { type: 'host-online' });
      // 手机可能先于 host 进房（如 Electron 重启），必须告知 host 对端已在，
      // 否则 host 认为手机离线而不下发目录
      if (this.ctx.getWebSockets('guest').length > 0) {
        server.send(JSON.stringify({ type: 'peer-joined' }));
      }
    } else {
      this.broadcast('host', { type: 'peer-joined' });
      const hostOnline = this.ctx.getWebSockets('host').length > 0;
      server.send(JSON.stringify({ type: hostOnline ? 'host-online' : 'host-offline' }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 解绑：广播离线、关连接、清空 storage（含 token） */
  private async onDelete(): Promise<Response> {
    this.broadcast('guest', { type: 'host-offline' });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'revoked');
      } catch {}
    }
    await this.ctx.storage.deleteAll();
    return json({ ok: true });
  }

  // ── hibernation handlers ──────────────────────────────────────────────
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const isHost = this.ctx.getTags(ws).includes('host');
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (size > MAX_FRAME_BYTES) {
      console.warn(`frame ${size}B over ${MAX_FRAME_BYTES} limit, dropped`);
      return;
    }
    for (const peer of this.ctx.getWebSockets(isHost ? 'guest' : 'host')) {
      try {
        peer.send(message);
      } catch {}
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const isHost = this.ctx.getTags(ws).includes('host');
    this.broadcast(isHost ? 'guest' : 'host', { type: isHost ? 'host-offline' : 'peer-left' });
  }

  private broadcast(tag: 'host' | 'guest', obj: unknown): void {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets(tag)) {
      try {
        ws.send(msg);
      } catch {}
    }
  }
}
