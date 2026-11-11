import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PairStore } from './pairStore';
import { createRelayServer, type RelayServer } from './relayServer';

let dir: string;
let relay: RelayServer;
let base: string;
let now: number;

async function start(desk: { id: string; manifest: string; root: string } | null = null) {
  relay = createRelayServer({
    store: new PairStore(path.join(dir, 'relay-pairs.json')),
    staticDir: path.join(dir, 'phone'),
    desk: async () => desk,
    now: () => now,
  });
  await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
}

const post = async (route: string, body: unknown) => {
  const res = await fetch(`${base}${route}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
};

async function pair(publicKey = 'host-public-key') {
  const requested = await post('/v1/pair/request', { publicKey });
  const claimed = await post('/v1/pair/claim', {
    publicKey,
    boxedKey: 'boxed',
    deviceName: 'Pixel',
  });
  const fetched = await post('/v1/pair/request', { publicKey });
  return { requested, claimed, fetched, pairId: requested.body.pairId };
}

interface Client {
  ws: WebSocket;
  next: () => Promise<{ data: string; binary: boolean }>;
  closed: Promise<{ code: number; reason: string }>;
}

function connect(pairId: string, role: string, token: string): Promise<Client> {
  const ws = new WebSocket(
    `${base.replace('http', 'ws')}/v1/pair/${pairId}?role=${role}&token=${encodeURIComponent(token)}`
  );
  const queue: { data: string; binary: boolean }[] = [];
  const waiters: ((m: { data: string; binary: boolean }) => void)[] = [];
  ws.on('message', (data, binary) => {
    const message = { data: data.toString(), binary };
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  );
  const next = () => {
    const queued = queue.shift();
    return queued
      ? Promise.resolve(queued)
      : new Promise<{ data: string; binary: boolean }>((r) => waiters.push(r));
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, next, closed }));
    ws.once('error', reject);
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-relay-'));
  now = 1_000_000;
});

afterEach(async () => {
  await relay?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('pairing', () => {
  it('requests, claims once and hands credentials to the host', async () => {
    await start();
    const { requested, claimed, fetched, pairId } = await pair();
    expect(requested.body).toEqual({ pairId, state: 'requested' });
    expect(pairId).toMatch(/^[\w-]{22}$/);
    expect(claimed.body).toMatchObject({ pairId, state: 'authorized' });
    expect(claimed.body.deviceToken).toBeTruthy();
    expect(fetched.body).toMatchObject({
      pairId,
      state: 'authorized',
      response: 'boxed',
      deviceName: 'Pixel',
    });
    expect(fetched.body.hostToken).toBeTruthy();

    const again = await post('/v1/pair/claim', { publicKey: 'host-public-key', boxedKey: 'x' });
    expect(again).toEqual({ status: 409, body: { error: 'already claimed' } });

    now += 200_000;
    expect((await post('/v1/pair/request', { publicKey: 'host-public-key' })).body).toEqual({
      pairId,
      state: 'authorized',
    });
  });

  it('validates bodies', async () => {
    await start();
    expect((await post('/v1/pair/request', {})).status).toBe(400);
    expect((await post('/v1/pair/claim', { publicKey: 'k' })).status).toBe(400);
    const res = await fetch(`${base}/v1/pair/request`, { method: 'POST', body: '{' });
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await post('/v1/pair/claim', { publicKey: 'k', boxedKey: 'b' })).status).toBe(409);
  });

  it('keeps authorized pairs across restarts', async () => {
    await start();
    const { fetched, pairId } = await pair();
    await relay.close();
    await start();
    const host = await connect(pairId, 'host', fetched.body.hostToken);
    host.ws.close();
  });
});

describe('rooms', () => {
  it('announces presence, forwards frames and answers ping', async () => {
    await start();
    const { fetched, claimed, pairId } = await pair();
    const host = await connect(pairId, 'host', fetched.body.hostToken);
    const guest = await connect(pairId, 'guest', claimed.body.deviceToken);
    expect(JSON.parse((await guest.next()).data)).toEqual({ type: 'host-online' });
    expect(JSON.parse((await host.next()).data)).toEqual({ type: 'peer-joined' });

    guest.ws.send(Buffer.from([1, 2, 3]));
    expect(await host.next()).toEqual({ data: '\u0001\u0002\u0003', binary: true });
    host.ws.send('hello');
    expect(await guest.next()).toEqual({ data: 'hello', binary: false });
    guest.ws.send('ping');
    expect(await guest.next()).toEqual({ data: 'pong', binary: false });

    guest.ws.close();
    expect(JSON.parse((await host.next()).data)).toEqual({ type: 'peer-left' });
    host.ws.close();
  });

  it('replaces a stale socket of the same role', async () => {
    await start();
    const { fetched, claimed, pairId } = await pair();
    const guest = await connect(pairId, 'guest', claimed.body.deviceToken);
    expect(JSON.parse((await guest.next()).data)).toEqual({ type: 'host-offline' });
    const host1 = await connect(pairId, 'host', fetched.body.hostToken);
    expect(JSON.parse((await guest.next()).data)).toEqual({ type: 'host-online' });
    const host2 = await connect(pairId, 'host', fetched.body.hostToken);
    expect(await host1.closed).toEqual({ code: 4001, reason: 'replaced' });
    expect(JSON.parse((await guest.next()).data)).toEqual({ type: 'host-online' });
    // 被顶掉的旧连接断开不应让对端以为宿主离线
    host2.ws.send('still here');
    expect((await guest.next()).data).toBe('still here');
    host2.ws.close();
    guest.ws.close();
  });

  it('rejects bad tokens and roles', async () => {
    await start();
    const { pairId } = await pair();
    const bad = await connect(pairId, 'host', 'nope');
    expect(await bad.closed).toEqual({ code: 1008, reason: 'revoked' });
    await expect(connect(pairId, 'admin', 'x')).rejects.toThrow(/400/);
  });

  it('revokes with either token and kicks both ends', async () => {
    await start();
    const { fetched, claimed, pairId } = await pair();
    const host = await connect(pairId, 'host', fetched.body.hostToken);
    const guest = await connect(pairId, 'guest', claimed.body.deviceToken);
    await guest.next();
    await host.next();

    const unauthorized = await fetch(`${base}/v1/pair/${pairId}?token=nope`, { method: 'DELETE' });
    expect(unauthorized.status).toBe(401);
    const ok = await fetch(`${base}/v1/pair/${pairId}?token=${fetched.body.hostToken}`, {
      method: 'DELETE',
    });
    expect(await ok.json()).toEqual({ ok: true });
    expect(JSON.parse((await guest.next()).data)).toEqual({ type: 'revoked' });
    expect(await guest.closed).toEqual({ code: 1008, reason: 'revoked' });
    expect(await host.closed).toEqual({ code: 1008, reason: 'revoked' });
    const again = await connect(pairId, 'guest', claimed.body.deviceToken);
    expect(await again.closed).toEqual({ code: 1008, reason: 'revoked' });
  });
});

describe('static', () => {
  beforeEach(() => {
    mkdirSync(path.join(dir, 'phone/assets'), { recursive: true });
    writeFileSync(path.join(dir, 'phone/index.html'), 'phone-index');
    writeFileSync(path.join(dir, 'phone/desk.html'), 'desk-shell');
    writeFileSync(path.join(dir, 'phone/assets/app-1.js'), 'js');
    writeFileSync(path.join(dir, 'secret.txt'), 'secret');
  });

  it('serves the phone app with SPA fallback', async () => {
    await start();
    const get = async (route: string) => {
      const res = await fetch(`${base}${route}`);
      return [
        res.status,
        await res.text(),
        res.headers.get('cache-control'),
        res.headers.get('content-type'),
      ];
    };
    expect(await get('/')).toEqual([200, 'phone-index', 'no-cache', 'text/html; charset=utf-8']);
    expect(await get('/desk')).toEqual([200, 'desk-shell', 'no-cache', 'text/html; charset=utf-8']);
    expect((await get('/assets/app-1.js')).slice(0, 3)).toEqual([
      200,
      'js',
      'public, max-age=31536000, immutable',
    ]);
    expect((await get('/sessions/abc')).slice(0, 2)).toEqual([200, 'phone-index']);
    expect((await get('/%2e%2e/secret.txt')).slice(0, 2)).toEqual([200, 'phone-index']);
    expect((await get('/healthz')).slice(0, 2)).toEqual([200, '{"ok":true}']);
    expect((await get('/v1/nope')).slice(0, 2)).toEqual([404, '{"error":"not found"}']);
    expect((await fetch(`${base}/`, { method: 'OPTIONS' })).status).toBe(204);
  });

  it('serves the desk bundle by manifest id only', async () => {
    const root = path.join(dir, 'renderer');
    mkdirSync(path.join(root, 'assets'), { recursive: true });
    writeFileSync(path.join(root, 'assets/index-1.js'), 'x'.repeat(4096));
    writeFileSync(path.join(root, 'index.html'), 'entry');
    const manifest = 'aa  assets/index-1.js\n';
    await start({ id: 'bundle1', manifest, root });

    expect(await (await fetch(`${base}/desk-bundle/bundle1`)).text()).toBe(manifest);
    const file = await fetch(`${base}/desk-bundle/bundle1/assets/index-1.js`);
    expect(file.headers.get('content-encoding')).toBe('gzip');
    expect(await file.text()).toBe('x'.repeat(4096));
    expect((await fetch(`${base}/desk-bundle/other`)).status).toBe(404);
    expect((await fetch(`${base}/desk-bundle/bundle1/index.html`)).status).toBe(404);
  });
});
