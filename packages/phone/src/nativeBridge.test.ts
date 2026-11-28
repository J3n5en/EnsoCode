import { attachHeartbeat } from '@enso/pair';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeOrBrowserRelaySocket,
  getNativeBridge,
  hasNativeDeskProxy,
  hasNativePip,
  isNativeIosApp,
  type NativePipSnapshot,
  type NativePipStatus,
  pushNativePipState,
  pushNativeWidgetState,
  registerNativeDeskFetcher,
  requestNativeQrScan,
  resolveNativePushGatewayOrigin,
  setNativePipAuto,
  startNativePip,
  stopNativePip,
  subscribeNativePipState,
} from './nativeBridge';
import {
  isPushSupported,
  pushAvailability,
  setNativePushGatewayResolver,
  subscribePush,
} from './push';
import {
  buildWidgetSnapshotFromCatalog,
  buildWidgetSnapshotFromDeskReads,
  DeskWidgetTracker,
} from './widgetState';

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

  it('原生 iOS 壳支持 APNs E2E 推送：pushAvailability 返回 ok，只使用 /healthz 返回 apns:true 的中继', async () => {
    const subscribeSpy = vi.fn(async (vapidKey: string, gatewayOrigin: string) => ({
      ok: true as const,
      subscription: {
        endpoint: `${gatewayOrigin}/v1/push/apns/prod/${'aa'.repeat(32)}?k=${vapidKey.slice(0, 8)}`,
        keys: { p256dh: 'p256-key', auth: 'auth-key' },
      },
    }));
    (window as unknown as Record<string, unknown>).__ensoNative = {
      platform: 'ios',
      push: true,
      subscribePush: subscribeSpy,
      unsubscribePush: vi.fn(),
    };

    expect(isPushSupported()).toBe(true);
    expect(pushAvailability()).toBe('ok');

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.startsWith('https://relay-apns.example.com')) {
        return new Response(JSON.stringify({ ok: true, apns: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, apns: false }), { status: 200 });
    }) as unknown as typeof fetch;

    const gw1 = await resolveNativePushGatewayOrigin('https://relay-apns.example.com');
    expect(gw1).toBe('https://relay-apns.example.com');
    const gw2 = await resolveNativePushGatewayOrigin('https://relay-no-apns.example.com');
    expect(gw2).toBeNull();

    // 未启用 APNs 的中继（如未配证书的 CF）返回 service-unreachable，避免假成功
    setNativePushGatewayResolver(() =>
      resolveNativePushGatewayOrigin('https://relay-no-apns.example.com')
    );
    const miss = await subscribePush('vapid-pub-123');
    expect(miss).toEqual({ ok: false, reason: 'service-unreachable' });
    expect(subscribeSpy).not.toHaveBeenCalled();

    // 已启用 APNs 的 Go 中继正常走原生订阅
    setNativePushGatewayResolver(() =>
      resolveNativePushGatewayOrigin('https://relay-apns.example.com')
    );
    const res = await subscribePush('vapid-pub-123');
    expect(res.ok).toBe(true);
    expect(subscribeSpy).toHaveBeenCalledWith('vapid-pub-123', 'https://relay-apns.example.com');

    // 负缓存穿透：中继刚上线 APNs 时再次探测不该被 5 分钟旧缓存卡住，且兼容 wss:// 输入
    let apnsReady = false;
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, apns: apnsReady }), { status: 200 })
    ) as unknown as typeof fetch;
    expect(await resolveNativePushGatewayOrigin('wss://relay-upgraded.example.com/')).toBeNull();
    apnsReady = true;
    expect(await resolveNativePushGatewayOrigin('wss://relay-upgraded.example.com/')).toBe(
      'https://relay-upgraded.example.com'
    );
  });

  it('小组件与灵动岛状态聚合：待审批优先于运行中，并同步给原生 updateWidgetState', () => {
    const updateSpy = vi.fn();
    (window as unknown as Record<string, unknown>).__ensoNative = {
      platform: 'ios',
      widgets: true,
      liveActivity: true,
      updateWidgetState: updateSpy,
    };

    const snap = buildWidgetSnapshotFromCatalog({
      deviceLabel: 'Mac Studio',
      connectionState: 'online',
      transport: 'direct',
      rttMs: 12,
      activeId: 's-idle',
      now: 1_700_000_000_000,
      catalog: [
        {
          id: 's-idle',
          title: '普通会话',
          projectName: 'demo',
          projectId: 'p1',
          status: 'idle',
          updatedAt: 100,
        },
        {
          id: 's-run',
          title: '正在跑构建',
          projectName: 'enso-code',
          projectId: 'p2',
          status: 'running',
          updatedAt: 200,
        },
        {
          id: 's-pending',
          title: '等待审批',
          projectName: 'enso-code',
          projectId: 'p2',
          status: 'waiting',
          pendingApprovalCount: 2,
          unread: true,
          updatedAt: 150,
        },
      ],
    });

    expect(snap.runningCount).toBe(1);
    expect(snap.pendingCount).toBe(2);
    expect(snap.activeSessionId).toBe('s-pending');
    expect(snap.activeStatus).toBe('pending');
    expect(snap.sessions[0]?.id).toBe('s-pending');
    expect(snap.sessions[1]?.id).toBe('s-run');

    pushNativeWidgetState(snap);
    expect(updateSpy).toHaveBeenCalledWith(snap);

    const deskSnap = buildWidgetSnapshotFromDeskReads({
      deviceLabel: 'MacBook',
      connectionState: 'online',
      transport: 'relay',
      rttMs: 38,
      now: 1_700_000_000_000,
      conversationsJson: JSON.stringify([
        { id: 'c1', title: 'Desk 会话', projectName: 'proj', status: 'running', updatedAt: 500 },
      ]),
    });
    expect(deskSnap.runningCount).toBe(1);
    expect(deskSnap.activeSessionId).toBe('c1');
  });

  it('DeskWidgetTracker 解析真实 conversations:read 结构并合并 agent:event 实时运行与待审批状态', () => {
    const tracker = new DeskWidgetTracker();
    tracker.ingestSettingsJson(
      JSON.stringify({
        'enso-settings': {
          state: { projects: [{ id: 'p-enso', name: 'enso-code', path: '/work/enso-code' }] },
        },
      })
    );
    tracker.ingestConversationsJson(
      JSON.stringify({
        seq: 12,
        value: {
          state: {
            conversations: {
              's-1': {
                id: 's-1',
                title: '优化 QUIC 与灵动岛',
                projectId: 'p-enso',
                status: 'idle',
                updatedAt: 1000,
              },
              's-2': {
                id: 's-2',
                title: '后台构建任务',
                projectId: 'p-enso',
                status: 'idle',
                updatedAt: 900,
              },
              's-child': {
                id: 's-child',
                title: '子代理',
                projectId: 'p-enso',
                parentId: 's-1',
                updatedAt: 1100,
              },
            },
          },
        },
      })
    );

    expect(
      tracker.applyAgentEventPayload(
        JSON.stringify([
          {
            type: 'snapshot',
            sessions: [
              {
                identity: { sessionId: 's-1' },
                status: 'running',
                pendingApprovals: [{ requestId: 'a1', toolName: 'bash' }],
                pendingAsks: [],
              },
              {
                identity: { sessionId: 's-2' },
                status: 'running',
                pendingApprovals: [],
                pendingAsks: [],
              },
              {
                identity: { sessionId: 's-child', parentSessionId: 's-1' },
                status: 'running',
                pendingApprovals: [],
                pendingAsks: [],
              },
            ],
          },
        ]),
        2000
      )
    ).toBe(true);

    const liveSnap = tracker.buildSnapshot({
      deviceLabel: '电脑 1',
      connectionState: 'online',
      transport: 'direct',
      rttMs: 12.6,
      now: 2500,
    });
    expect(liveSnap.rttMs).toBe(13);
    expect(liveSnap.runningCount).toBe(2);
    expect(liveSnap.pendingCount).toBe(1);
    expect(liveSnap.activeSessionId).toBe('s-1');
    expect(liveSnap.activeTitle).toBe('优化 QUIC 与灵动岛');
    expect(liveSnap.activeProject).toBe('enso-code');
    expect(liveSnap.activeStatus).toBe('pending');
    expect(liveSnap.activeDetail).toBe('等待审批 bash');
    expect(liveSnap.sessions.map((s) => s.id)).toEqual(['s-1', 's-2']);

    tracker.applyAgentEventPayload(
      JSON.stringify([
        { type: 'approval-resolved', identity: { sessionId: 's-1' }, requestId: 'a1' },
      ]),
      3000
    );
    tracker.applyAgentEventPayload(
      JSON.stringify([{ type: 'turn-completed', identity: { sessionId: 's-1' } }]),
      3100
    );
    tracker.applyAgentEventPayload(
      JSON.stringify([{ type: 'status', identity: { sessionId: 's-2' }, status: 'idle' }]),
      3200
    );
    const doneSnap = tracker.buildSnapshot({
      deviceLabel: '电脑 1',
      connectionState: 'online',
      transport: 'direct',
      rttMs: 12,
      now: 3300,
    });
    expect(doneSnap.runningCount).toBe(0);
    expect(doneSnap.pendingCount).toBe(0);
    expect(doneSnap.activeStatus).toBe('idle');
  });
});

describe('nativeBridge 画中画', () => {
  const setBridge = (bridge: Record<string, unknown> | undefined) => {
    (globalThis as Record<string, unknown>).window = globalThis.window ?? {};
    const win = window as unknown as Record<string, unknown>;
    if (bridge) win.__ensoNative = bridge;
    else delete win.__ensoNative;
  };

  afterEach(() => setBridge(undefined));

  const snapshot: NativePipSnapshot = {
    sessionId: 's1',
    title: '会话',
    projectName: 'proj',
    status: 'running',
    pendingHint: null,
    runningCount: 1,
    pendingCount: 0,
    connectionState: 'online',
    messages: [],
    updatedAt: 1,
  };

  it('只有原生声明 pip 且带 startPip 才算支持；不支持时调用全部静默', () => {
    setBridge(undefined);
    expect(hasNativePip()).toBe(false);
    expect(() => {
      startNativePip();
      stopNativePip();
      setNativePipAuto(true);
      pushNativePipState(snapshot);
    }).not.toThrow();
    expect(subscribeNativePipState(() => {})).toBeTypeOf('function');

    setBridge({ platform: 'ios', pip: true });
    expect(hasNativePip()).toBe(false);
    setBridge({ platform: 'ios', pip: false, startPip: () => {} });
    expect(hasNativePip()).toBe(false);
    setBridge({ platform: 'ios', pip: true, startPip: () => {} });
    expect(hasNativePip()).toBe(true);
  });

  it('start / stop / setAuto / push 原样转给原生，原生抛错不外泄', () => {
    const startPip = vi.fn();
    const stopPip = vi.fn();
    const setPipAuto = vi.fn();
    const updatePipState = vi.fn(() => {
      throw new Error('native gone');
    });
    setBridge({ platform: 'ios', pip: true, startPip, stopPip, setPipAuto, updatePipState });
    startNativePip();
    stopNativePip();
    setNativePipAuto(false);
    expect(() => pushNativePipState(snapshot)).not.toThrow();
    expect(startPip).toHaveBeenCalledTimes(1);
    expect(stopPip).toHaveBeenCalledTimes(1);
    expect(setPipAuto).toHaveBeenCalledWith(false);
    expect(updatePipState).toHaveBeenCalledWith(snapshot);
  });

  it('subscribeNativePipState：只向原生挂一次回调，多订阅者都收到，晚到的先回放最近状态', () => {
    const native: { cb?: (state: unknown) => void } = {};
    const onPipState = vi.fn((cb: (state: unknown) => void) => {
      native.cb = cb;
    });
    setBridge({ platform: 'ios', pip: true, startPip: () => {}, onPipState });

    const a: NativePipStatus[] = [];
    const b: NativePipStatus[] = [];
    const offA = subscribeNativePipState((s) => a.push(s));
    subscribeNativePipState((s) => b.push(s));
    expect(onPipState).toHaveBeenCalledTimes(1);
    expect(a).toEqual([]);

    native.cb?.({ supported: true, active: true, auto: false });
    expect(a).toEqual([
      { supported: true, active: true, auto: false, aspect: 'portrait', error: null },
    ]);
    expect(b).toHaveLength(1);

    const late: NativePipStatus[] = [];
    subscribeNativePipState((s) => late.push(s));
    expect(late).toEqual([
      { supported: true, active: true, auto: false, aspect: 'portrait', error: null },
    ]);
    expect(onPipState).toHaveBeenCalledTimes(1);

    offA();
    native.cb?.({
      supported: true,
      active: false,
      auto: true,
      aspect: 'square',
      error: 'interrupted',
    });
    expect(a).toHaveLength(1);
    expect(b.at(-1)).toEqual({
      supported: true,
      active: false,
      auto: true,
      aspect: 'square',
      error: 'interrupted',
    });
    expect(late).toHaveLength(2);

    native.cb?.('garbage');
    expect(late).toHaveLength(2);
  });
});
