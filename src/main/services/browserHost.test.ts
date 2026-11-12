import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const fakeTabs: Array<{
  contents: EventEmitter & {
    id: number;
    getURL: () => string;
    getTitle: () => string;
    isLoading: () => boolean;
    isDestroyed: () => boolean;
    isDevToolsOpened: () => boolean;
    close: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    executeJavaScript: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    navigationHistory: {
      canGoBack: () => boolean;
      canGoForward: () => boolean;
      clear: ReturnType<typeof vi.fn>;
    };
    debugger: EventEmitter & {
      isAttached: () => boolean;
      attach: ReturnType<typeof vi.fn>;
      detach: ReturnType<typeof vi.fn<() => void>>;
      sendCommand: ReturnType<typeof vi.fn>;
    };
  };
}> = [];

// getSession() 里 fire-and-forget 地动态导入 proxyConfig，真实模块会连带加载 agentHost 等一长串依赖；
// 全量跑测试负载高时，加载拖到本文件环境拆除之后，报成未处理的 EnvironmentTeardownError
vi.mock('./proxyConfig', () => ({ getProxyConfig: () => ({ attachSession: () => {} }) }));
vi.mock('electron', () => {
  class FakeWebContentsView {
    webContents: (typeof fakeTabs)[number]['contents'];
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    setBorderRadius = vi.fn();
    setVisible = vi.fn();
    getBounds = () => ({ x: 0, y: 0, width: 1280, height: 800 });
    constructor() {
      const dbgEmitter = new EventEmitter();
      let attached = false;
      const dbg = Object.assign(dbgEmitter, {
        isAttached: () => attached,
        attach: vi.fn(() => {
          attached = true;
        }),
        detach: vi.fn(() => {
          attached = false;
        }),
        sendCommand: vi.fn(async () => ({})),
      });
      let currentUrl = 'https://example.com/a';
      let destroyed = false;
      const wcEmitter = new EventEmitter();
      const contents = Object.assign(wcEmitter, {
        id: fakeTabs.length + 1,
        getURL: () => currentUrl,
        getTitle: () => 'Test',
        isLoading: () => false,
        isDestroyed: () => destroyed,
        isDevToolsOpened: () => false,
        close: vi.fn(() => {
          destroyed = true;
          wcEmitter.emit('destroyed');
        }),
        loadURL: vi.fn(async (url: string) => {
          currentUrl = url;
        }),
        executeJavaScript: vi.fn(async () => true),
        setWindowOpenHandler: vi.fn(),
        navigationHistory: {
          canGoBack: () => false,
          canGoForward: () => false,
          clear: vi.fn(),
        },
        debugger: dbg,
      });
      this.webContents = contents;
      fakeTabs.push({ contents });
    }
  }
  return {
    app: { isPackaged: false, getPath: () => '/tmp' },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() },
        cookies: { flushStore: vi.fn(async () => {}) },
        flushStorageData: vi.fn(async () => {}),
      }),
    },
    WebContentsView: FakeWebContentsView,
  };
});

import {
  BrowserHost,
  dragInputEvents,
  hiddenTabCdpCommands,
  interpretPageAction,
  isBrowserPartition,
  pageScreenshotCdpParams,
  partitionName,
  shownTabCdpCommands,
} from './browserHost';

describe('partitionName', () => {
  it('dev 与打包版分罐，且都是 persist', () => {
    expect(partitionName(true)).toBe('persist:enso-browser');
    expect(partitionName(false)).toBe('persist:enso-dev-browser');
    expect(isBrowserPartition(partitionName(true))).toBe(true);
    expect(isBrowserPartition(partitionName(false))).toBe(true);
  });
  it('clear 只认我们自己的罐', () => {
    expect(isBrowserPartition('persist:enso')).toBe(false);
    expect(isBrowserPartition('enso-browser')).toBe(false);
    expect(isBrowserPartition('')).toBe(false);
  });
});

describe('BrowserHost designMode across navigation', () => {
  it('re-registers Runtime.addBinding and re-injects design runtime on subsequent dom-ready after navigating to another URL', async () => {
    fakeTabs.length = 0;
    const host = new BrowserHost();
    await host.userNavigate('tab-nav', 'session-1', 'https://example.com/start');
    const created = fakeTabs[0];
    expect(created).toBeDefined();
    const contents = created!.contents;

    // First page dom-ready
    contents.emit('dom-ready');
    await host.setDesignMode('tab-nav', true);

    const addBindingCallsBefore = contents.debugger.sendCommand.mock.calls.filter(
      ([method]) => method === 'Runtime.addBinding'
    ).length;
    expect(addBindingCallsBefore).toBeGreaterThanOrEqual(1);

    // Navigate via address bar to another URL while Annotate is active
    await host.userNavigate('tab-nav', 'session-1', 'https://another-domain.example.org/page');
    contents.emit('did-navigate');
    contents.emit('dom-ready');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const addBindingCallsAfter = contents.debugger.sendCommand.mock.calls.filter(
      ([method]) => method === 'Runtime.addBinding'
    ).length;
    expect(addBindingCallsAfter).toBeGreaterThan(addBindingCallsBefore);

    // Verify that clicking an element on the newly navigated page emits exactly one 'select' event
    const received: unknown[] = [];
    const off = host.onDesignMode((event) => {
      if (event.type === 'select') received.push(event);
    });
    contents.debugger.emit('message', {}, 'Runtime.bindingCalled', {
      name: 'ensoDesignMode',
      payload: JSON.stringify({
        type: 'select',
        elements: [
          {
            tag: 'button',
            component: 'BuyButton',
            rect: { x: 10, y: 20, width: 80, height: 32 },
            uid: 'cursor-el-1',
            hueIndex: 0,
          },
        ],
        region: null,
        addToChat: false,
        viewportWidth: 1280,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    off();
    expect(received).toHaveLength(1);
  });

  it('allows browser_tabs select by tabId so the agent can jump back to an annotated browser tab', async () => {
    fakeTabs.length = 0;
    const host = new BrowserHost();
    await host.userNavigate('tab-first', 'session-1', 'https://example.com');
    await host.userNavigate('tab-second', 'session-1', 'https://example.org');

    const res = (await host.invoke('session-1', 'tabs', {
      action: 'select',
      tabId: 'tab-first',
    })) as { selected: string; tabs: Array<{ tabId: string; active: boolean }> };

    expect(res.selected).toBe('tab-first');
    expect(res.tabs.find((t) => t.tabId === 'tab-first')?.active).toBe(true);
  });
});

describe('BrowserHost 标注模式的 debugger 监听', () => {
  // 审计发现：debugger 每断开一次，再进标注模式就在同一个 debugger 上多挂一份监听，
  // N 轮后同一条 Runtime.bindingCalled 被处理 N 次，约 10 轮触发 MaxListenersExceededWarning
  it('debugger 断开后多轮重进标注模式，同一条页面消息仍只处理一次', async () => {
    fakeTabs.length = 0;
    const host = new BrowserHost();
    await host.userNavigate('tab-dbg', 'session-1', 'https://example.com/start');
    const contents = fakeTabs[0]!.contents;
    contents.emit('dom-ready');
    await host.setDesignMode('tab-dbg', true);
    for (let round = 0; round < 3; round += 1) {
      // 真实 Electron 里 debugger 断开（DevTools 抢占、显式 detach）会发 detach 事件
      contents.debugger.detach();
      contents.debugger.emit('detach', {}, 'target closed');
      await host.setDesignMode('tab-dbg', false);
      await host.setDesignMode('tab-dbg', true);
    }

    const drawing: unknown[] = [];
    const off = host.onDesignMode((event) => {
      if (event.type === 'drawing') drawing.push(event);
    });
    contents.debugger.emit('message', {}, 'Runtime.bindingCalled', {
      name: 'ensoDesignMode',
      payload: JSON.stringify({ type: 'drawing', drawing: true }),
    });
    off();
    expect(drawing).toHaveLength(1);
  });
});

describe('BrowserHost tab 生命周期', () => {
  // 审计发现：destroyTab 在 await flush() 期间同 id 的 tab 被重建，旧 webContents 的 destroyed 回调按 id 删表，把新 tab 删掉
  it('关闭 tab 途中同一 tab 被重新打开，旧页面销毁时不会删掉新 tab', async () => {
    fakeTabs.length = 0;
    const host = new BrowserHost();
    await host.userNavigate('tab-reopen', 'session-1', 'https://example.com/old');
    const closing = host.closeTab('tab-reopen');
    // closeTab 已同步摘掉旧 tab、正等 flush：此时用户又打开同一个 tab
    await host.userNavigate('tab-reopen', 'session-1', 'https://example.com/new');
    await closing;
    expect(host.state('tab-reopen').url).toBe('https://example.com/new');
  });
});

describe('BrowserHost CDP 连接失败', () => {
  // 审计发现：cdp() 里 debugger.attach 没有保护，抛错时 layout() 里 void this.cdp(...) 变成未处理的 rejection
  it('debugger 连不上时布局照常进行，不留下未处理的 rejection', async () => {
    fakeTabs.length = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const host = new BrowserHost();
      const children: unknown[] = [];
      host.setHostWindow(
        () =>
          ({
            isDestroyed: () => false,
            contentView: {
              children,
              addChildView: (view: unknown) => {
                if (!children.includes(view)) children.push(view);
              },
              removeChildView: (view: unknown) => {
                children.splice(children.indexOf(view), 1);
              },
            },
          }) as never
      );
      await host.userNavigate('tab-cdp', 'session-1', 'https://example.com');
      const contents = fakeTabs[0]!.contents;
      contents.debugger.attach.mockImplementation(() => {
        throw new Error('Another debugger is already attached');
      });
      // 首次 dom-ready 触发 layout，给隐藏的 tab 下发 CDP 命令
      contents.emit('dom-ready');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('pageScreenshotCdpParams', () => {
  const clip = { x: 0, y: 0, width: 1280, height: 800, scale: 1 };

  it('默认 beyond viewport，给被挡住的无头 tab 离屏出帧', () => {
    expect(pageScreenshotCdpParams(clip)).toEqual({
      format: 'png',
      captureBeyondViewport: true,
      clip,
    });
  });

  it('冻帧必须拍当前合成视口，否则 position:fixed 顶栏会丢', () => {
    expect(pageScreenshotCdpParams(undefined, { captureBeyondViewport: false })).toEqual({
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });
  });
});

describe('hidden tab rendering', () => {
  it('emulates focus so background tabs keep rAF without being the visible Chrome tab', () => {
    expect(hiddenTabCdpCommands()).toEqual(
      expect.arrayContaining([
        {
          method: 'Emulation.setFocusEmulationEnabled',
          params: { enabled: true },
        },
        expect.objectContaining({ method: 'Emulation.setDeviceMetricsOverride' }),
      ])
    );
    expect(shownTabCdpCommands()).toEqual(
      expect.arrayContaining([
        { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } },
        { method: 'Emulation.clearDeviceMetricsOverride', params: {} },
      ])
    );
  });
});

describe('interpretPageAction', () => {
  it('keeps covered distinct from stale so the model re-snapshots instead of retrying a dead ref', () => {
    expect(interpretPageAction('e1', 'ok')).toBeNull();
    expect(interpretPageAction('e1', 'covered')?.message).toMatch(/covered|hittable/);
    expect(interpretPageAction('e1', 'stale')?.message).toMatch(/stale/);
    expect(interpretPageAction('e1', 'not-editable')?.message).toMatch(/not editable/);
  });
});

describe('dragInputEvents', () => {
  it('emits a trusted mouseDown-move-mouseUp path so HTML5 drag can start', () => {
    const events = dragInputEvents({ x: 10, y: 20 }, { x: 110, y: 80 });
    expect(events[0]).toMatchObject({ type: 'mouseDown', x: 10, y: 20, button: 'left' });
    expect(events.at(-1)).toMatchObject({ type: 'mouseUp', x: 110, y: 80, button: 'left' });
    const moves = events.filter((event) => event.type === 'mouseMove');
    expect(moves.length).toBeGreaterThanOrEqual(8);
    expect(moves[0]?.button).toBe('left');
    expect(
      events.some((event) => event.type === 'mouseMove' && event.x === 10 && event.y === 20)
    ).toBe(false);
    const firstMove = moves[0];
    expect(firstMove).toBeDefined();
    const nudge = Math.hypot((firstMove?.x ?? 0) - 10, (firstMove?.y ?? 0) - 20);
    expect(nudge).toBeGreaterThanOrEqual(7);
  });
});
