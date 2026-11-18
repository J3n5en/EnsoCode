import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  chats: [{ id: 'g', kind: 'group', activeThreadId: 't' }],
  delegations: [],
  openThread: vi.fn(),
  setView: vi.fn(),
}));
vi.mock('@/stores/bots', () => ({ useBotsStore: { getState: () => state } }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: { getState: () => ({ botModeEnabled: true }) },
}));
afterEach(() => vi.unstubAllGlobals());

it('主话题通知即使当前看子话题也打开主话题，不沿用侧栏最近选择', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  const { openBotNotification } = await import('./mode');
  await openBotNotification({ kind: 'open', chatId: 'g' });
  expect(state.openThread).toHaveBeenCalledWith('g', 'g');
  expect(state.setView).toHaveBeenCalledWith({ kind: 'chat', chatId: 'g' });
});

it('Code 会话通知从 Bot 模式切回 Code 视图', async () => {
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { getItem: () => 'bot', setItem });
  vi.resetModules();
  const { showLocalCodeView, useAppModeStore } = await import('./mode');
  expect(useAppModeStore.getState().mode).toBe('bot');
  showLocalCodeView();
  expect(useAppModeStore.getState().mode).toBe('code');
});
