/**
 * 内置 web：同一端口提供手机 PWA、桌面 renderer 资源包与中继协议（/v1/pair/*）。
 * 行为对齐 packages/relay-go，手机端与宿主端代码无需区分内置还是公共中继。
 */
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { type WebSocket, WebSocketServer } from 'ws';
import {
  canFetchCredentials,
  MAX_FRAME_BYTES,
  pairIdFromPublicKey,
  tokenValid,
} from '../../../packages/relay/src/pairing';
import { assetMime, normalizeAssetPath } from '../../main/services/remoteRenderer/assets';
import type { PairStore } from './pairStore';

export interface DeskBundle {
  id: string;
  manifest: string;
  root: string;
}

export interface RelayServerOptions {
  store: PairStore;
  /** 手机 PWA 产物目录；缺失时只提供中继协议 */
  staticDir: string | null;
  desk: () => Promise<DeskBundle | null>;
  now?: () => number;
}

export interface RelayServer {
  server: Server;
  close: () => Promise<void>;
}

type Role = 'host' | 'guest';
type Message = Record<string, string>;

const IMMUTABLE = 'public, max-age=31536000, immutable';
const INCOMPRESSIBLE = new Set(['.woff2', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3']);
const PING_MS = 30_000;

const mime = (file: string): string =>
  file.endsWith('.webmanifest') ? 'application/manifest+json' : assetMime(file);

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_FRAME_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function deviceName(raw: string): string {
  const name = [...raw].slice(0, 64).join('');
  return name || 'phone';
}

/** 每个 pairId 一间房，宿主与手机各一个连接；同角色新连接顶掉旧的 */
class Hub {
  private readonly rooms = new Map<string, Partial<Record<Role, WebSocket>>>();

  join(pairId: string, role: Role, ws: WebSocket): void {
    const room = this.rooms.get(pairId) ?? {};
    this.rooms.set(pairId, room);
    const stale = room[role];
    room[role] = ws;
    stale?.close(4001, 'replaced');
    const other = room[role === 'host' ? 'guest' : 'host'];
    if (role === 'host') {
      if (other) {
        send(other, { type: 'host-online' });
        send(ws, { type: 'peer-joined' });
      }
    } else if (other) {
      send(other, { type: 'peer-joined' });
      send(ws, { type: 'host-online' });
    } else {
      send(ws, { type: 'host-offline' });
    }
  }

  leave(pairId: string, role: Role, ws: WebSocket): void {
    const room = this.rooms.get(pairId);
    if (room?.[role] !== ws) return;
    delete room[role];
    const other = room[role === 'host' ? 'guest' : 'host'];
    if (other) send(other, { type: role === 'host' ? 'host-offline' : 'peer-left' });
    else this.rooms.delete(pairId);
  }

  forward(pairId: string, from: Role, data: Buffer, binary: boolean): void {
    const dst = this.rooms.get(pairId)?.[from === 'host' ? 'guest' : 'host'];
    if (dst && dst.readyState === dst.OPEN) dst.send(data, { binary });
  }

  revoke(pairId: string): void {
    const room = this.rooms.get(pairId);
    this.rooms.delete(pairId);
    for (const ws of [room?.host, room?.guest]) {
      if (!ws) continue;
      send(ws, { type: 'revoked' });
      ws.close(1008, 'revoked');
    }
  }
}

function send(ws: WebSocket, message: Message): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

export function createRelayServer(options: RelayServerOptions): RelayServer {
  const { store, staticDir, desk } = options;
  const now = options.now ?? Date.now;
  const hub = new Hub();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const gzipped = new Map<string, Buffer>();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const publicKey = str(body?.publicKey);
    if (!body) return json(res, 400, { error: 'invalid json' });
    if (!publicKey) return json(res, 400, { error: 'missing publicKey' });
    const pairId = await pairIdFromPublicKey(publicKey);
    const at = now();
    const state = store.request(pairId, publicKey, at);
    if (state.phase !== 'authorized') return json(res, 200, { pairId, state: 'requested' });
    if (!canFetchCredentials(state, at)) return json(res, 200, { pairId, state: 'authorized' });
    json(res, 200, {
      pairId,
      state: 'authorized',
      hostToken: state.hostToken,
      response: state.boxedKey,
      deviceName: state.deviceName,
    });
  }

  async function handleClaim(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: 'invalid json' });
    const publicKey = str(body.publicKey);
    const boxedKey = str(body.boxedKey);
    if (!publicKey) return json(res, 400, { error: 'missing publicKey' });
    if (!boxedKey) return json(res, 400, { error: 'missing boxedKey' });
    const pairId = await pairIdFromPublicKey(publicKey);
    const result = store.claim(pairId, boxedKey, deviceName(str(body.deviceName)), now());
    if (typeof result === 'string') return json(res, 409, { error: result });
    json(res, 200, { pairId, state: 'authorized', deviceToken: result.deviceToken });
  }

  async function serveDesk(req: IncomingMessage, res: ServerResponse, rest: string): Promise<void> {
    const bundle = await desk();
    const [id, ...parts] = rest.split('/');
    const file = parts.length ? normalizeAssetPath(decodeURIComponent(parts.join('/'))) : '';
    const listed = file === '' || (file !== null && bundle?.manifest.includes(`  ${file}\n`));
    if (!bundle || id !== bundle.id || !listed || file === null) {
      return json(res, 404, { error: 'not found' });
    }
    cors(res);
    res.setHeader('Cache-Control', IMMUTABLE);
    if (!file) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(bundle.manifest);
      return;
    }
    const data = await readFile(path.join(bundle.root, file)).catch(() => null);
    if (!data) return json(res, 404, { error: 'not found' });
    res.setHeader('Content-Type', mime(file));
    res.setHeader('Vary', 'Accept-Encoding');
    const gzip =
      !INCOMPRESSIBLE.has(path.extname(file)) &&
      /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    if (!gzip) return void res.end(req.method === 'HEAD' ? undefined : data);
    const key = `${bundle.id}/${file}`;
    let packed = gzipped.get(key);
    if (!packed) {
      packed = gzipSync(data, { level: 9 });
      gzipped.set(key, packed);
    }
    res.setHeader('Content-Encoding', 'gzip');
    res.end(req.method === 'HEAD' ? undefined : packed);
  }

  async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      cors(res);
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end('method not allowed');
      return;
    }
    if (!staticDir) return json(res, 404, { error: 'not found' });
    const read = async (rel: string | null) =>
      rel
        ? readFile(path.join(staticDir, rel)).then(
            (data) => ({ rel, data }),
            () => null
          )
        : null;
    let rel: string | null = null;
    try {
      rel =
        pathname === '/' ? 'index.html' : normalizeAssetPath(decodeURIComponent(pathname.slice(1)));
    } catch {}
    const hit =
      (await read(rel)) ??
      (rel && !path.extname(rel) ? await read(`${rel}.html`) : null) ??
      (await read('index.html'));
    if (!hit) return json(res, 404, { error: 'not found' });
    cors(res);
    res.writeHead(200, {
      'Content-Type': mime(hit.rel),
      'Cache-Control': hit.rel.endsWith('.html') ? 'no-cache' : IMMUTABLE,
    });
    res.end(req.method === 'HEAD' ? undefined : hit.data);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204).end();
      return;
    }
    const { pathname, searchParams } = new URL(req.url ?? '/', 'http://relay');
    if (pathname === '/v1/pair/request' && req.method === 'POST') return handleRequest(req, res);
    if (pathname === '/v1/pair/claim' && req.method === 'POST') return handleClaim(req, res);
    if (pathname === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true });
    if (pathname.startsWith('/desk-bundle/') && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveDesk(req, res, pathname.slice('/desk-bundle/'.length));
    }
    const pairId = pairIdOf(pathname);
    if (pairId && req.method === 'DELETE') {
      if (!store.revoke(pairId, searchParams.get('token') ?? '', now())) {
        return json(res, 401, { error: 'unauthorized' });
      }
      hub.revoke(pairId);
      return json(res, 200, { ok: true });
    }
    if (pathname.startsWith('/v1/')) return json(res, 404, { error: 'not found' });
    return serveStatic(req, res, pathname);
  }

  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal' });
      else res.destroy();
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url ?? '/', 'http://relay');
    const pairId = pairIdOf(pathname);
    const role = searchParams.get('role');
    if (!pairId) return void socket.destroy();
    if (role !== 'host' && role !== 'guest') {
      socket.end(
        'HTTP/1.1 400 Bad Request\r\nContent-Length: 8\r\nConnection: close\r\n\r\nbad role'
      );
      return;
    }
    const authorized = tokenValid(store.get(pairId), role, searchParams.get('token') ?? '');
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!authorized) return void ws.close(1008, 'revoked');
      let alive = true;
      ws.on('pong', () => {
        alive = true;
      });
      // 反代常按空闲超时断开（nginx 默认 60s），协议层 ping 保活
      const ping = setInterval(() => {
        if (!alive) return void ws.terminate();
        alive = false;
        ws.ping();
      }, PING_MS);
      ws.on('message', (data: Buffer, binary) => {
        if (!binary && data.length === 4 && data.toString() === 'ping') return void ws.send('pong');
        hub.forward(pairId, role, data, binary);
      });
      ws.on('close', () => {
        clearInterval(ping);
        hub.leave(pairId, role, ws);
      });
      ws.on('error', () => ws.terminate());
      hub.join(pairId, role, ws);
    });
  });

  const close = () =>
    new Promise<void>((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections();
      server.close(() => resolve());
    });

  return { server, close };
}

function pairIdOf(pathname: string): string | null {
  const prefix = '/v1/pair/';
  if (!pathname.startsWith(prefix)) return null;
  const id = pathname.slice(prefix.length);
  if (!id || id.includes('/') || id === 'request' || id === 'claim') return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}
