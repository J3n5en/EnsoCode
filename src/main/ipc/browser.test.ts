import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  listeners: new Map<string, (...args: any[]) => unknown>(),
  host: {
    setOverlayActive: vi.fn(),
    setViewport: vi.fn(() => 'state'),
    setDevToolsViewport: vi.fn(() => 'state'),
    resetOverlayReports: vi.fn(),
    state: vi.fn(() => 'empty'),
    onState: vi.fn(),
    onReveal: vi.fn(),
    onTabClosed: vi.fn(),
    onDesignMode: vi.fn(),
    describeSelection: vi.fn(async () => ({ elements: [], image: null })),
    moveSelection: vi.fn(async () => ({
      elements: [],
      description: { elements: [], image: null },
    })),
    clearSelection: vi.fn(async () => true),
    setAnnotationPins: vi.fn(async () => true),
    openAnnotationPin: vi.fn(async () => null),
    readDesignCss: vi.fn(async () => null),
    previewDesignCss: vi.fn(async () => null),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
    on: (channel: string, handler: (...args: any[]) => unknown) => {
      mocks.listeners.set(channel, handler);
    },
  },
}));
vi.mock('../services/browserHost', () => ({ browserHost: mocks.host }));
vi.mock('../windows/createAppWindow', () => ({ sendToAllWindows: () => {} }));
vi.mock('../windows/MainWindow', () => ({ isMainWebContents: (id: number) => id === 1 }));

import { IPC_CHANNELS } from '@shared/types';
import { registerBrowserHandlers } from './browser';

const sender = (id: number) => {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  return {
    id,
    on(name: string, fn: (...args: any[]) => void) {
      listeners[name] = [...(listeners[name] ?? []), fn];
    },
    emit(name: string, ...args: any[]) {
      for (const fn of listeners[name] ?? []) fn(...args);
    },
  };
};

beforeEach(() => {
  mocks.handlers.clear();
  mocks.listeners.clear();
  for (const fn of Object.values(mocks.host)) fn.mockClear();
  registerBrowserHandlers();
});

it('浮层 / 矩形上报只认主窗口 renderer', () => {
  const overlay = mocks.listeners.get(IPC_CHANNELS.BROWSER_SET_OVERLAY_ACTIVE)!;
  const setViewport = mocks.handlers.get(IPC_CHANNELS.BROWSER_SET_VIEWPORT)!;
  const setDevtoolsViewport = mocks.handlers.get(IPC_CHANNELS.BROWSER_SET_DEVTOOLS_VIEWPORT)!;

  overlay({ sender: sender(2) }, true);
  expect(mocks.host.setOverlayActive).not.toHaveBeenCalled();
  setViewport({ sender: sender(2) }, 'tab', 'conv', null, true);
  expect(mocks.host.setViewport).not.toHaveBeenCalled();
  setDevtoolsViewport({ sender: sender(2) }, 'tab', 'conv', null, true);
  expect(mocks.host.setDevToolsViewport).not.toHaveBeenCalled();

  overlay({ sender: sender(1) }, true);
  expect(mocks.host.setOverlayActive).toHaveBeenCalledWith(true);
  setViewport({ sender: sender(1) }, 'tab', 'conv', null, true);
  expect(mocks.host.setViewport).toHaveBeenCalledWith('tab', 'conv', null, true);
});

it('上报方崩溃 / 销毁 / 整页重载后清掉浮层闩锁', () => {
  const overlay = mocks.listeners.get(IPC_CHANNELS.BROWSER_SET_OVERLAY_ACTIVE)!;

  const crashed = sender(1);
  overlay({ sender: crashed }, true);
  crashed.emit('render-process-gone', {}, { reason: 'crashed' });
  expect(mocks.host.resetOverlayReports).toHaveBeenCalledTimes(1);
  crashed.emit('destroyed');
  expect(mocks.host.resetOverlayReports).toHaveBeenCalledTimes(2);

  const reloaded = sender(1);
  overlay({ sender: reloaded }, true);
  reloaded.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  reloaded.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  expect(mocks.host.resetOverlayReports).toHaveBeenCalledTimes(2);
  reloaded.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  expect(mocks.host.resetOverlayReports).toHaveBeenCalledTimes(3);
});

it('Design Mode Annotate IPC 校验入参并转发给 browserHost', async () => {
  const describeSelection = mocks.handlers.get(IPC_CHANNELS.BROWSER_DESCRIBE_SELECTION)!;
  const moveSelection = mocks.handlers.get(IPC_CHANNELS.BROWSER_MOVE_SELECTION)!;
  const clearSelection = mocks.handlers.get(IPC_CHANNELS.BROWSER_CLEAR_SELECTION)!;
  const setPins = mocks.handlers.get(IPC_CHANNELS.BROWSER_SET_ANNOTATION_PINS)!;
  const openPin = mocks.handlers.get(IPC_CHANNELS.BROWSER_OPEN_ANNOTATION_PIN)!;
  const readCss = mocks.handlers.get(IPC_CHANNELS.BROWSER_READ_DESIGN_CSS)!;
  const previewCss = mocks.handlers.get(IPC_CHANNELS.BROWSER_PREVIEW_DESIGN_CSS)!;

  await describeSelection({}, '', undefined);
  expect(mocks.host.describeSelection).not.toHaveBeenCalled();
  await describeSelection({}, 'tab-1', { x: 10, y: 20, width: 100, height: 50 });
  expect(mocks.host.describeSelection).toHaveBeenCalledWith('tab-1', {
    x: 10,
    y: 20,
    width: 100,
    height: 50,
  });

  await moveSelection({}, 'tab-1', 'invalid');
  expect(mocks.host.moveSelection).not.toHaveBeenCalled();
  await moveSelection({}, 'tab-1', 'parent');
  expect(mocks.host.moveSelection).toHaveBeenCalledWith('tab-1', 'parent');

  await clearSelection({}, 'tab-1');
  expect(mocks.host.clearSelection).toHaveBeenCalledWith('tab-1');

  await setPins({}, 'tab-1', 'http://localhost:3000', []);
  expect(mocks.host.setAnnotationPins).toHaveBeenCalledWith('tab-1', 'http://localhost:3000', []);

  await openPin({}, 'tab-1', 'pin-1', true);
  expect(mocks.host.openAnnotationPin).toHaveBeenCalledWith('tab-1', 'pin-1', true);

  await readCss({}, 'tab-1', 'uid-1');
  expect(mocks.host.readDesignCss).toHaveBeenCalledWith('tab-1', 'uid-1');

  await previewCss({}, 'tab-1', 'draft', { 'uid-1': { color: 'red' } });
  expect(mocks.host.previewDesignCss).toHaveBeenCalledWith('tab-1', 'draft', {
    'uid-1': { color: 'red' },
  });
});
