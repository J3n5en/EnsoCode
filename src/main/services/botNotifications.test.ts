import { beforeEach, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  focused: false,
  click: () => {},
  show: vi.fn(),
  focus: vi.fn(),
  send: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported() {
      return true;
    }
    on(_event: string, cb: () => void) {
      env.click = cb;
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
vi.mock('../windows/createAppWindow', () => ({ sendToWindow: env.send }));

import { maybeNotifyBot, notifyBotChat } from './notifications';

const event = {
  type: 'ask-request' as const,
  identity: { sessionId: 's', generation: 'g' },
  seq: 1,
  ask: { requestId: 'q', question: 'Question?', options: [] },
};
beforeEach(() => {
  vi.clearAllMocks();
  env.focused = false;
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
