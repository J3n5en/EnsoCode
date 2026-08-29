import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import {
  canFetchCredentials,
  claim,
  MAX_FRAME_BYTES,
  type PairState,
  request,
  tokenValid,
} from './pairing';

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
    if (path === '/delete') return this.onDelete(req);
    return json({ error: 'not found' }, 404);
  }

  /** host 发起 + 轮询：无 state/过期则建 requested；authorized 时在取回窗口内回凭据 */
  private async onRequest(req: Request): Promise<Response> {
    const pairId = req.headers.get('x-pair-id') ?? '';
    const { publicKey } = (await req.json()) as { publicKey: string };
    const now = Date.now();
    const prev = await this.ctx.storage.get<PairState>('state');
    const next = request(prev, now, publicKey);
    if (next !== prev) await this.ctx.storage.put('state', next);
    if (next.phase === 'authorized') {
      // 窗口外不再吐凭据：publicKey 在 QR 里公开，长期可换 token 等于把
      // host 身份长期暴露给任何看过二维码的人
      if (!canFetchCredentials(next, now)) {
        return json({ pairId, state: 'authorized' });
      }
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
    if (!tokenValid(state, role, token)) {
      /*
       * 凭据失效（多为对端已解绑）。这里不能只回 401：浏览器拿不到握手的状态码，
       * onclose 只会收到 1006，与网络断开无法区分，客户端就会永远重连。
       * 先接受连接再以 1008 关闭，两端都能确定地识别为「已解绑」。
       */
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const [rejectClient, rejectServer] = Object.values(new WebSocketPair()) as [
          WebSocket,
          WebSocket,
        ];
        rejectServer.accept();
        rejectServer.close(1008, 'revoked');
        return new Response(null, { status: 101, webSocket: rejectClient });
      }
      return new Response('unauthorized', { status: 401 });
    }

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    // 同角色旧连接（网络切换/睡眠唤醒后的半开残留）先关掉：否则它迟到的 close
    // 会在新连接建立后向对端广播离线，把真实在线状态覆盖成假离线
    for (const stale of this.ctx.getWebSockets(role)) {
      try {
        stale.close(1000, 'replaced');
      } catch {}
    }
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

  /** 解绑：需持 host 或 guest token（双方都可发起）；广播离线、关连接、清空 storage */
  private async onDelete(req: Request): Promise<Response> {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    const state = await this.ctx.storage.get<PairState>('state');
    // 未鉴权的 DELETE 等于任何知道 pairId 的人都能强制解绑
    if (!tokenValid(state, 'host', token) && !tokenValid(state, 'guest', token)) {
      return json({ error: 'unauthorized' }, 401);
    }
    /*
     * 向双方广播明确的 revoked 帧再关连接。旧实现只发 guest 一条 host-offline，
     * host 端收不到任何通知、且关闭码是 1000，两端都会把解绑误当成网络断开而无限重连。
     */
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ type: 'revoked' }));
      } catch {}
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1008, 'revoked');
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
    // 该角色还有存活连接（对端已重连成功）就不广播离线：
    // 被顶替/半开的旧连接迟到关闭，不代表对端真的离线
    const alive = this.ctx.getWebSockets(isHost ? 'host' : 'guest').filter((w) => w !== ws);
    if (alive.length > 0) return;
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
