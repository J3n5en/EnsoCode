import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isTriggerId,
  parseTriggerEventObject,
  parseTriggerInboundPayload,
  TRIGGER_HTTP_MAX_BYTES,
  type TriggerInboundEvent,
} from '@shared/secretary/triggers';
import { type WebSocket, WebSocketServer } from 'ws';

export type TriggerAuthFailure = 'not-found' | 'unauthorized' | 'disabled';

export type TriggerAuthResult = { ok: true } | { ok: false; error: TriggerAuthFailure };

export type TriggerDispatchError =
  | TriggerAuthFailure
  | 'rate-limited'
  | 'invalid-payload'
  | 'secretary-disabled';

export type TriggerDispatchResult =
  | { ok: true; deliveryKey: string; deduplicated: boolean }
  | { ok: false; error: TriggerDispatchError };

export interface TriggerServerDeps {
  authenticate(triggerId: string, token: string): TriggerAuthResult;
  dispatch(triggerId: string, token: string, event: TriggerInboundEvent): TriggerDispatchResult;
}

export interface LocalTriggerServer {
  start(port: number): Promise<number>;
  stop(): Promise<void>;
  port(): number | null;
  running(): boolean;
}

const HTTP_ROUTE = /^\/v1\/triggers\/([^/]+)$/;
const WS_ROUTE = /^\/v1\/triggers\/([^/]+)\/ws$/;
const MAX_TOTAL_WS = 32;
const MAX_PER_TRIGGER_WS = 4;
const WS_AUTH_TIMEOUT_MS = 5_000;
const WS_HEARTBEAT_MS = 30_000;

function extractToken(req: IncomingMessage): string {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const header = req.headers['x-enso-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return '';
}

function hasBrowserOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return typeof origin === 'string' && origin.trim().length > 0;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function statusOfError(error: TriggerDispatchError): number {
  switch (error) {
    case 'not-found':
      return 404;
    case 'unauthorized':
      return 401;
    case 'disabled':
    case 'secretary-disabled':
      return 403;
    case 'rate-limited':
      return 429;
    case 'invalid-payload':
      return 400;
  }
}

function readBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<{ ok: true; text: string } | { ok: false; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: { ok: true; text: string } | { ok: false; tooLarge: boolean }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.resume();
        finish({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf-8') }));
    req.on('error', () => finish({ ok: false, tooLarge: false }));
  });
}

function rejectUpgrade(
  socket: import('node:stream').Duplex,
  status: number,
  message: string
): void {
  const body = JSON.stringify({ ok: false, error: message });
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
  );
  socket.destroy();
}

interface WsClientState {
  triggerId: string;
  token: string | null;
  alive: boolean;
  authTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * 仅监听 127.0.0.1 的同端口 HTTP POST + WebSocket 触发服务端。
 * 拒绝任何带 Origin 头的浏览器跨站请求，防 DNS rebinding 与 CSRF。
 */
export function createTriggerServer(deps: TriggerServerDeps): LocalTriggerServer {
  let httpServer: Server | null = null;
  let wss: WebSocketServer | null = null;
  let boundPort: number | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const clients = new Map<WebSocket, WsClientState>();

  function countForTrigger(triggerId: string): number {
    let count = 0;
    for (const state of clients.values()) {
      if (state.triggerId === triggerId) count += 1;
    }
    return count;
  }

  function sendWs(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  function cleanupWs(ws: WebSocket): void {
    const state = clients.get(ws);
    if (state?.authTimer) clearTimeout(state.authTimer);
    clients.delete(ws);
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (hasBrowserOrigin(req)) {
      sendJson(res, 403, { ok: false, error: 'origin-not-allowed' });
      return;
    }
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'GET' && urlPath === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    const match = HTTP_ROUTE.exec(urlPath);
    if (!match) {
      sendJson(res, 404, { ok: false, error: 'not-found' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      return;
    }
    const triggerId = match[1] ?? '';
    if (!isTriggerId(triggerId)) {
      sendJson(res, 404, { ok: false, error: 'not-found' });
      return;
    }
    const token = extractToken(req);
    const auth = deps.authenticate(triggerId, token);
    if (!auth.ok) {
      sendJson(res, statusOfError(auth.error), { ok: false, error: auth.error });
      return;
    }
    const body = await readBody(req, TRIGGER_HTTP_MAX_BYTES);
    if (!body.ok) {
      sendJson(res, body.tooLarge ? 413 : 400, {
        ok: false,
        error: body.tooLarge ? 'payload-too-large' : 'read-failed',
      });
      return;
    }
    const contentType =
      typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined;
    const parsed = parseTriggerInboundPayload(body.text, contentType);
    if (!parsed.ok) {
      sendJson(res, 400, { ok: false, error: parsed.error });
      return;
    }
    const result = deps.dispatch(triggerId, token, parsed.event);
    if (!result.ok) {
      sendJson(res, statusOfError(result.error), { ok: false, error: result.error });
      return;
    }
    sendJson(res, 202, {
      ok: true,
      deliveryKey: result.deliveryKey,
      deduplicated: result.deduplicated,
    });
  }

  function handleWsMessage(ws: WebSocket, raw: Buffer | string): void {
    const state = clients.get(ws);
    if (!state) return;
    const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
    if (Buffer.byteLength(text, 'utf-8') > TRIGGER_HTTP_MAX_BYTES) {
      sendWs(ws, { type: 'error', error: 'payload-too-large' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendWs(ws, { type: 'error', error: 'invalid-json' });
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendWs(ws, { type: 'error', error: 'invalid-frame' });
      return;
    }
    const frame = parsed as Record<string, unknown>;
    const frameType = typeof frame.type === 'string' ? frame.type : '';
    const frameId =
      typeof frame.id === 'string' || typeof frame.id === 'number' ? frame.id : undefined;

    if (frameType === 'ping') {
      sendWs(ws, { type: 'pong', ...(frameId !== undefined ? { id: frameId } : {}) });
      return;
    }

    if (state.token === null) {
      if (frameType !== 'auth' || typeof frame.token !== 'string') {
        sendWs(ws, { type: 'error', error: 'auth-required' });
        ws.close(4001, 'auth-required');
        return;
      }
      const auth = deps.authenticate(state.triggerId, frame.token.trim());
      if (!auth.ok) {
        sendWs(ws, { type: 'error', error: auth.error });
        ws.close(4001, auth.error);
        return;
      }
      if (state.authTimer) {
        clearTimeout(state.authTimer);
        state.authTimer = null;
      }
      state.token = frame.token.trim();
      sendWs(ws, { type: 'ready', triggerId: state.triggerId });
      return;
    }

    if (frameType !== 'event') {
      sendWs(ws, {
        type: 'ack',
        ...(frameId !== undefined ? { id: frameId } : {}),
        ok: false,
        error: 'unknown-type',
      });
      return;
    }

    const event = parseTriggerEventObject(frame);
    if (!event.ok) {
      sendWs(ws, {
        type: 'ack',
        ...(frameId !== undefined ? { id: frameId } : {}),
        ok: false,
        error: event.error,
      });
      return;
    }

    const result = deps.dispatch(state.triggerId, state.token, event.event);
    if (!result.ok) {
      sendWs(ws, {
        type: 'ack',
        ...(frameId !== undefined ? { id: frameId } : {}),
        ok: false,
        error: result.error,
      });
      if (
        result.error === 'unauthorized' ||
        result.error === 'not-found' ||
        result.error === 'disabled'
      ) {
        ws.close(4003, result.error);
      }
      return;
    }
    sendWs(ws, {
      type: 'ack',
      ...(frameId !== undefined ? { id: frameId } : {}),
      ok: true,
      deliveryKey: result.deliveryKey,
      deduplicated: result.deduplicated,
    });
  }

  return {
    async start(port: number): Promise<number> {
      if (httpServer && boundPort !== null) return boundPort;
      const server = createServer((req, res) => {
        void handleHttp(req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal-error' });
        });
      });
      const wsServer = new WebSocketServer({
        noServer: true,
        maxPayload: TRIGGER_HTTP_MAX_BYTES,
      });

      server.on('upgrade', (req, socket, head) => {
        if (hasBrowserOrigin(req)) {
          rejectUpgrade(socket, 403, 'origin-not-allowed');
          return;
        }
        const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
        const match = WS_ROUTE.exec(urlPath);
        const triggerId = match?.[1] ?? '';
        if (!match || !isTriggerId(triggerId)) {
          rejectUpgrade(socket, 404, 'not-found');
          return;
        }
        if (clients.size >= MAX_TOTAL_WS || countForTrigger(triggerId) >= MAX_PER_TRIGGER_WS) {
          rejectUpgrade(socket, 429, 'too-many-connections');
          return;
        }
        const headerToken = extractToken(req);
        if (headerToken) {
          const auth = deps.authenticate(triggerId, headerToken);
          if (!auth.ok) {
            rejectUpgrade(socket, statusOfError(auth.error), auth.error);
            return;
          }
        }
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          const state: WsClientState = {
            triggerId,
            token: headerToken || null,
            alive: true,
            authTimer: null,
          };
          if (!headerToken) {
            state.authTimer = setTimeout(() => {
              if (state.token === null) ws.close(4001, 'auth-timeout');
            }, WS_AUTH_TIMEOUT_MS);
            state.authTimer.unref?.();
          }
          clients.set(ws, state);
          ws.on('pong', () => {
            state.alive = true;
          });
          ws.on('message', (data) => {
            state.alive = true;
            handleWsMessage(ws, Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
          });
          ws.on('close', () => cleanupWs(ws));
          ws.on('error', () => cleanupWs(ws));
          if (headerToken) sendWs(ws, { type: 'ready', triggerId });
        });
      });

      const listenedPort = await new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          const addr = server.address() as AddressInfo | null;
          resolve(addr?.port ?? port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });

      httpServer = server;
      wss = wsServer;
      boundPort = listenedPort;
      heartbeat = setInterval(() => {
        for (const [ws, state] of clients) {
          if (!state.alive) {
            ws.terminate();
            cleanupWs(ws);
            continue;
          }
          state.alive = false;
          ws.ping();
        }
      }, WS_HEARTBEAT_MS);
      heartbeat.unref?.();
      return listenedPort;
    },

    async stop(): Promise<void> {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      for (const ws of [...clients.keys()]) {
        cleanupWs(ws);
        try {
          ws.terminate();
        } catch {
          // 忽略关闭异常
        }
      }
      const wsServer = wss;
      wss = null;
      if (wsServer) {
        await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      }
      const server = httpServer;
      httpServer = null;
      boundPort = null;
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },

    port(): number | null {
      return boundPort;
    },

    running(): boolean {
      return httpServer !== null;
    },
  };
}
