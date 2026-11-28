import { attachHeartbeat } from '@enso/pair';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeOrBrowserRelaySocket,
  getNativeBridge,
  hasNativeDeskProxy,
  isNativeIosApp,
  registerNativeDeskFetcher,
  requestNativeQrScan,
} from './nativeBridge';

describe('nativeBridge (iOS 原生壳桥接 + QUIC Happy Eyeballs 回落)', () => {
  const origWindow = globalThis.window;
  const origWebSocket = globalThis.WebSocket;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    // Clear any prior bridge state
    (globalThis as Record<string, unknown>).window = globalThis.window ?? {};
    delete (window as unknown as Record<string, unknown>).__ensoNative;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).__ensoNative;
    (globalThis as Record<string, unknown>).WebSocket = origWebSocket;
    (globalThis as Record<string, unknown>).fetch = origFetch;
    if (!origWindow) delete (globalThis as Record<string, unknown>).window;
  });

  it('普通浏览器环境识别为非原生壳，直接走标准 WebSocket', () => {
    expect(isNativeIosApp()).toBe(false);
    expect(hasNativeDeskProxy()).toBe(false);
    expect(getNativeBridge()).toBeNull();

    const created: string[] = [];
    class FakeWS {
      readyState = 0;
      binaryType = '';
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
      constructor(url: string) {
        created.push(url);
      }
      send() {}
      close() {}
    }
    (globalThis as Record<string, unknown>).WebSocket = FakeWS;

    const sock = createNativeOrBrowserRelaySocket({
      relayUrl: 'https://relay.example.com',
      wsUrl: 'wss://relay.example.com/v1/pair/p1?role=guest&token=t1',
      pairId: 'p1',
      role: 'guest',
      token: 't1',
    });
    expect(sock).toBeInstanceOf(FakeWS);
    expect(created).toEqual(['wss://relay.example.com/v1/pair/p1?role=guest&token=t1']);
  });

  it('原生壳检测到 /healthz quic:true 时走原生 QUIC 通道，并支持 ctrl/bulk 分车道发送', async () => {
    const sent: { id: string; lane: string; b64: string }[] = [];
    let openCb: ((id: string) => void) | null = null;
    let binaryCb: ((id: string, b64: string) => void) | null = null;
    let controlCb: ((id: string, text: string) => void) | null = null;

    const nativeMock = {
      platform: 'ios' as const,
      quic: true,
      deskProxy: true,
      openQuic: vi.fn((_opts: { id: string; host: string; port: number; alpn: string }) => {}),
      sendQuicText: vi.fn(),
      sendQuicBinary: vi.fn((id: string, lane: 'ctrl' | 'bulk', b64: string) => {
        sent.push({ id, lane, b64 });
      }),
      closeQuic: vi.fn(),
      scanQr: vi.fn(async () => 'enso://pair?relay=https://r&pk=abc'),
      onQuicOpen: (cb: (id: string) => void) => {
        openCb = cb;
      },
      onQuicControl: (cb: (id: string, text: string) => void) => {
        controlCb = cb;
      },
      onQuicBinary: (cb: (id: string, b64: string) => void) => {
        binaryCb = cb;
      },
      onQuicClose: () => {},
    };
    (window as unknown as Record<string, unknown>).__ensoNative = nativeMock;

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, quic: true, quicPort: 8443, alpn: 'enso-pair/1' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
    ) as unknown as typeof fetch;

    expect(isNativeIosApp()).toBe(true);
    expect(hasNativeDeskProxy()).toBe(true);
    expect(await requestNativeQrScan()).toBe('enso://pair?relay=https://r&pk=abc');

    const sock = createNativeOrBrowserRelaySocket({
      relayUrl: 'https://relay.example.com',
      wsUrl: 'wss://relay.example.com/v1/pair/p1?role=guest&token=t1',
      pairId: 'p1',
      role: 'guest',
      token: 't1',
    });
    const opened = vi.fn();
    const received: unknown[] = [];
    sock.onopen = opened;
    sock.onmessage = (e) => received.push(e.data);

    // Flush /healthz promise
    await vi.advanceTimersByTimeAsync(10);
    expect(nativeMock.openQuic).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'relay.example.com',
        port: 8443,
        alpn: 'enso-pair/1',
        pairId: 'p1',
        role: 'guest',
        token: 't1',
      })
    );
    const id = (nativeMock.openQuic.mock.calls[0][0] as { id: string }).id;
    openCb!(id);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(sock.readyState).toBe(1);
    expect(sock.transportKind).toBe('quic');

    // Send ctrl + bulk binary frames
    sock.sendOnLane?.(new Uint8Array([1, 2, 3]), 'ctrl');
    sock.sendOnLane?.(new Uint8Array([9, 8, 7]), 'bulk');
    expect(sent.map((s) => s.lane)).toEqual(['ctrl', 'bulk']);

    // Receive control text and binary frame
    controlCb!(id, JSON.stringify({ type: 'host-online', relayEpoch: 'e1', relaySeq: 0 }));
    binaryCb!(id, btoa('hi'));
    expect(received[0]).toBe(
      JSON.stringify({ type: 'host-online', relayEpoch: 'e1', relaySeq: 0 })
    );
    expect(new TextDecoder().decode(new Uint8Array(received[1] as ArrayBuffer))).toBe('hi');
  });

  it('QUIC 250ms 未建连时自动 Happy Eyeballs 回落到标准 WebSocket', async () => {
    const wsCreated: string[] = [];
    class FakeWS {
      readyState = 0;
      binaryType = '';
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onclose: ((e: { code: number; reason: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        wsCreated.push(url);
      }
      send() {}
      close() {}
    }
    (globalThis as Record<string, unknown>).WebSocket = FakeWS;

    const nativeMock = {
      platform: 'ios' as const,
      quic: true,
      deskProxy: true,
      openQuic: vi.fn(),
      sendQuicText: vi.fn(),
      sendQuicBinary: vi.fn(),
      closeQuic: vi.fn(),
      onQuicOpen: () => {},
      onQuicControl: () => {},
      onQuicBinary: () => {},
      onQuicClose: () => {},
    };
    (window as unknown as Record<string, unknown>).__ensoNative = nativeMock;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, quic: true, quicPort: 443, alpn: 'enso-pair/1' }), {
          status: 200,
        })
    ) as unknown as typeof fetch;

    const sock = createNativeOrBrowserRelaySocket({
      relayUrl: 'https://blocked-udp.example.com',
      wsUrl: 'wss://blocked-udp.example.com/v1/pair/p2?role=guest&token=t2',
      pairId: 'p2',
      role: 'guest',
      token: 't2',
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(nativeMock.openQuic).toHaveBeenCalledTimes(1);
    expect(wsCreated).toHaveLength(0);

    // 250ms Happy Eyeballs timeout triggers WSS fallback
    await vi.advanceTimersByTimeAsync(300);
    expect(wsCreated).toEqual(['wss://blocked-udp.example.com/v1/pair/p2?role=guest&token=t2']);
    expect(nativeMock.closeQuic).toHaveBeenCalledTimes(1);
    sock.close();
  });

  it('兼容 attachHeartbeat 的 addEventListener/removeEventListener（WSS 回落与 QUIC 路径都不抛异常）', async () => {
    const sent: unknown[] = [];
    let fakeWs: {
      readyState: number;
      binaryType: string;
      onopen: (() => void) | null;
      onmessage: ((e: { data: unknown }) => void) | null;
      onclose: ((e: { code: number; reason: string }) => void) | null;
      onerror: (() => void) | null;
      send: (d: unknown) => void;
      close: () => void;
    } | null = null;
    class FakeWS {
      readyState = 0;
      binaryType = '';
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onclose: ((e: { code: number; reason: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        fakeWs = this;
      }
      send(d: unknown) {
        sent.push(d);
      }
      close() {
        this.readyState = 3;
      }
    }
    (globalThis as Record<string, unknown>).WebSocket = FakeWS;
    (window as unknown as Record<string, unknown>).__ensoNative = {
      platform: 'ios',
      quic: true,
      deskProxy: true,
      openQuic: vi.fn(),
      closeQuic: vi.fn(),
      onQuicOpen: () => {},
      onQuicControl: () => {},
      onQuicBinary: () => {},
      onQuicClose: () => {},
    };
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as unknown as typeof fetch;

    const sock = createNativeOrBrowserRelaySocket({
      relayUrl: 'https://relay-no-quic.example.com',
      wsUrl: 'wss://relay-no-quic.example.com/v1/pair/p3?role=guest&token=t3',
      pairId: 'p3',
      role: 'guest',
      token: 't3',
    });
    const onDead = vi.fn();
    const rtts: number[] = [];
    const hb = attachHeartbeat(sock as unknown as WebSocket, onDead, (ms) => rtts.push(ms));

    await vi.advanceTimersByTimeAsync(10);
    expect(fakeWs).not.toBeNull();
    fakeWs!.readyState = 1;
    fakeWs!.onopen?.();
    expect(sent).toEqual(['ping']);

    await vi.advanceTimersByTimeAsync(25);
    fakeWs!.onmessage?.({ data: 'pong' });
    expect(rtts).toEqual([25]);
    expect(onDead).not.toHaveBeenCalled();

    hb.stop();
    sock.close();
  });

  it('registerNativeDeskFetcher 将请求回调暴露给原生壳供本地代理拉取资源', async () => {
    const replies: unknown[] = [];
    (window as unknown as Record<string, unknown>).__ensoNative = {
      platform: 'ios',
      quic: true,
      deskProxy: true,
      replyDeskAsset: (reqId: string, status: number, mime: string, bodyB64: string) => {
        replies.push({ reqId, status, mime, bodyB64 });
      },
    };

    const unregister = registerNativeDeskFetcher(async (path) => ({
      status: 200,
      mime: 'text/plain',
      body: new TextEncoder().encode(`asset:${path}`),
    }));

    const hook = (
      window as unknown as { __ensoDeskNativeFetch?: (id: string, path: string) => void }
    ).__ensoDeskNativeFetch;
    expect(typeof hook).toBe('function');
    hook!('req-1', 'r/index.html');
    await vi.advanceTimersByTimeAsync(0);
    expect(replies).toEqual([
      { reqId: 'req-1', status: 200, mime: 'text/plain', bodyB64: btoa('asset:r/index.html') },
    ]);
    unregister();
  });
});
