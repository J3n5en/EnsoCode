import { beforeEach, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  focused: false,
  click: () => {},
  show: vi.fn(),
  focus: vi.fn(),
  send: vi.fn(),
  loading: false,
  onceLoad: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported() {
      return true;
    }
    on(name: string, cb: () => void) {
      if (name === 'click') env.click = cb;
    }
    show() {
      env.show();
    }
  },
}));
vi.mock('../ipc/settings', () => ({ readSettings: () => ({}) }));
vi.mock('../windows/MainWindow', () => ({
  getMainWindow: () => ({ isFocused: () => env.focused }),
  focusMainWindow: env.focus,
}));
vi.mock('../windows/createAppWindow', () => ({
  sendToWindow: env.send,
  getWindowWebContents: () => ({ isLoading: () => env.loading, once: env.onceLoad }),
}));

import {
  maybeNotify,
  maybeNotifyBot,
  notifyBotChat,
  notifySecretary,
  setLocalLayerVisible,
} from './notifications';

const event = {
  type: 'ask-request' as const,
  identity: { sessionId: 's', generation: 'g' },
  seq: 1,
  ask: { requestId: 'q', question: 'Question?', options: [] },
};
beforeEach(() => {
  vi.clearAllMocks();
  env.focused = false;
  env.loading = false;
  env.focus.mockReset();
  setLocalLayerVisible(true);
});
it('code session notices focus the main window and open the session on click', async () => {
  const win = { id: 'main' };
  env.focus.mockReturnValueOnce(win);
  maybeNotify({ ...event, seq: 2, ask: { ...event.ask, requestId: 'code-1' } });
  env.click();
  await vi.waitFor(() =>
    expect(env.send).toHaveBeenCalledWith(win, 'notification:focus-session', 's')
  );
  expect(env.focus).toHaveBeenCalledOnce();
});
it('code session notices wait for a recreated window to load before opening the session', async () => {
  const win = { id: 'main' };
  env.focus.mockReturnValueOnce(win);
  env.loading = true;
  maybeNotify({ ...event, seq: 3, ask: { ...event.ask, requestId: 'code-2' } });
  env.click();
  await vi.waitFor(() => expect(env.onceLoad).toHaveBeenCalledOnce());
  expect(env.send).not.toHaveBeenCalled();
  const [name, onLoad] = env.onceLoad.mock.calls[0] as [string, () => void];
  expect(name).toBe('did-finish-load');
  onLoad();
  expect(env.send).toHaveBeenCalledWith(win, 'notification:focus-session', 's');
});
it('notifies background bot questions and opens the chat on click', async () => {
  await maybeNotifyBot(event, {
    enabled: true,
    chatId: 'chat',
    name: 'Alice',
    conversationId: 's',
  });
  expect(env.show).toHaveBeenCalledOnce();
  env.click();
  expect(env.focus).toHaveBeenCalledOnce();
  expect(env.send).toHaveBeenCalledWith(undefined, 'bots:event', {
    kind: 'open',
    chatId: 'chat',
    conversationId: 's',
  });
});
it('delegated child sessions without a chat still request navigation by conversation', async () => {
  await maybeNotifyBot(event, { enabled: true, chatId: null, name: 'Alice', conversationId: 's' });
  env.click();
  expect(env.send).toHaveBeenCalledWith(undefined, 'bots:event', {
    kind: 'open',
    conversationId: 's',
  });
});
it('does not notify foreground or disabled bot mode', async () => {
  await maybeNotifyBot(event, {
    enabled: false,
    chatId: 'chat',
    name: 'Alice',
    conversationId: 's',
  });
  env.focused = true;
  await maybeNotifyBot(event, {
    enabled: true,
    chatId: 'chat',
    name: 'Alice',
    conversationId: 's',
  });
  expect(env.show).not.toHaveBeenCalled();
});
it('bot chat notices use the language setting, open the chat on click and stay quiet in the foreground', async () => {
  const build = vi.fn((lang: 'zh' | 'en') => ({ title: `t-${lang}`, body: 'b' }));
  await notifyBotChat('chat', build);
  expect(build).toHaveBeenCalledWith('zh');
  expect(env.show).toHaveBeenCalledOnce();
  env.click();
  expect(env.send).toHaveBeenCalledWith(undefined, 'bots:event', { kind: 'open', chatId: 'chat' });
  env.focused = true;
  await notifyBotChat('chat', build);
  expect(env.show).toHaveBeenCalledOnce();
});
it('主窗口聚焦但盖着远程节点界面时，Bot 与秘书通知照弹', async () => {
  env.focused = true;
  setLocalLayerVisible(false);
  await maybeNotifyBot(
    { ...event, seq: 9, ask: { ...event.ask, requestId: 'layer' } },
    { enabled: true, chatId: 'chat', name: 'Alice', conversationId: 's' }
  );
  await notifyBotChat('chat', () => ({ title: 't', body: 'b' }));
  await notifySecretary(() => ({ title: 't', body: 'b' }));
  expect(env.show).toHaveBeenCalledTimes(3);
});
