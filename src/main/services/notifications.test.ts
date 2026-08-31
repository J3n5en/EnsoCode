import type { RendererAgentEvent } from '@shared/types/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { notifications, windows, execFileCalls, appState } = vi.hoisted(() => ({
  notifications: [] as { title: string; body: string }[],
  windows: [] as { isFocused: () => boolean }[],
  execFileCalls: [] as unknown[][],
  appState: { isPackaged: true },
}));

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    execFileCalls.push(args);
  },
}));

vi.mock('electron', () => {
  class Notification {
    static isSupported = () => true;
    constructor(options: { title: string; body: string }) {
      notifications.push({ title: options.title, body: options.body });
    }
    on() {}
    show() {}
  }
  return {
    Notification,
    BrowserWindow: { getAllWindows: () => windows },
    app: {
      getPath: () => '/tmp/enso-code-test',
      getName: () => 'enso-code',
      on: () => {},
      get isPackaged() {
        return appState.isPackaged;
      },
    },
    ipcMain: { handle: () => {}, on: () => {} },
  };
});

vi.mock('../ipc/settings', () => ({ readSettings: () => undefined }));

import { maybeNotify, setViewedSession } from './notifications';

const identity = { sessionId: 'conversation-1', generation: 'g' } as const;

const askEvent = (question: string): RendererAgentEvent =>
  ({
    type: 'ask-request',
    identity,
    seq: 1,
    ask: { requestId: 'r1', question },
  }) as unknown as RendererAgentEvent;

describe('maybeNotify', () => {
  beforeEach(() => {
    notifications.length = 0;
    windows.length = 0; // 缺省无聚焦窗口 = 用户不在
    execFileCalls.length = 0;
    appState.isPackaged = true;
    setViewedSession(null);
  });

  it('ask-request 在窗口未聚焦时弹通知,正文取问题前 100 字', () => {
    maybeNotify(askEvent(`为什么${'长'.repeat(200)}`));
    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toHaveLength(100);
    expect(notifications[0].body.startsWith('为什么')).toBe(true);
  });

  it('窗口聚焦且正在看该会话时不打扰', () => {
    windows.push({ isFocused: () => true });
    setViewedSession('conversation-1');
    maybeNotify(askEvent('在吗'));
    maybeNotify({
      type: 'approval-request',
      identity,
      seq: 2,
      request: { requestId: 'r2', tool: 'bash', summary: 'rm -rf /tmp/x' },
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(0);
  });

  it('窗口聚焦但正在看别的会话时照弹', () => {
    windows.push({ isFocused: () => true });
    setViewedSession('conversation-2');
    maybeNotify(askEvent('在吗'));
    expect(notifications).toHaveLength(1);
  });

  it('窗口聚焦但没在看任何会话(如设置页)时照弹', () => {
    windows.push({ isFocused: () => true });
    maybeNotify(askEvent('在吗'));
    expect(notifications).toHaveLength(1);
  });

  it('窗口聚焦且正看着 coworker tab 时,该 coworker 的 ask 不弹', () => {
    windows.push({ isFocused: () => true });
    setViewedSession('conversation-1::cw-bob');
    maybeNotify({
      type: 'ask-request',
      identity: { sessionId: 'conversation-1::cw-bob', generation: 'g' },
      seq: 9,
      ask: { requestId: 'r9', question: '选哪个?' },
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(0);
  });

  it('coworker 的 turn-completed 不弹,但 ask-request 照弹(阻塞必须提醒)', () => {
    const coworker = { sessionId: 'conversation-1::cw-bob', generation: 'g' } as const;
    maybeNotify({
      type: 'turn-completed',
      identity: coworker,
      seq: 3,
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(0);
    maybeNotify({
      type: 'ask-request',
      identity: coworker,
      seq: 4,
      ask: { requestId: 'r3', question: '选哪个方案?' },
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(1);
  });

  it('macOS 未打包(未签名)时直接走 osascript,不碰原生 Notification', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    appState.isPackaged = false;
    try {
      maybeNotify(askEvent('在吗'));
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
    expect(notifications).toHaveLength(0);
    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0][0]).toBe('osascript');
    expect(String((execFileCalls[0][1] as string[])[1])).toContain('在吗');
  });

  it('打包后走原生 Notification,不走 osascript', () => {
    maybeNotify(askEvent('在吗'));
    expect(notifications).toHaveLength(1);
    expect(execFileCalls).toHaveLength(0);
  });

  it('无关事件不弹', () => {
    maybeNotify({
      type: 'status',
      identity,
      seq: 5,
      status: 'running',
    } as unknown as RendererAgentEvent);
    expect(notifications).toHaveLength(0);
  });
});
