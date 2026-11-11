import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const fakeTabs: Array<{
  contents: EventEmitter & {
    id: number;
    getURL: () => string;
    getTitle: () => string;
    isLoading: () => boolean;
    isDestroyed: () => boolean;
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
      detach: ReturnType<typeof vi.fn>;
      sendCommand: ReturnType<typeof vi.fn>;
    };
  };
}> = [];

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
      const wcEmitter = new EventEmitter();
      const contents = Object.assign(wcEmitter, {
        id: fakeTabs.length + 1,
        getURL: () => currentUrl,
        getTitle: () => 'Test',
        isLoading: () => false,
        isDestroyed: () => false,
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
