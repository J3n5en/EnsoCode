import { beforeEach, describe, expect, it, vi } from 'vitest';

const selected = vi.hoisted(() => [] as string[]);

vi.mock('@/stores/settings', () => ({
  useSettingsStore: { getState: () => ({ botModeEnabled: true }) },
}));
vi.mock('@/stores/bots', () => ({ useBotsStore: { getState: () => ({}) } }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: {
    getState: () => ({
      selectConversation: (id: string) => selected.push(`select:${id}`),
      selectTab: (rootId: string, tabId: string) => selected.push(`tab:${rootId}/${tabId}`),
    }),
  },
}));
vi.mock('@/lib/sidePanelDock', () => ({}));
vi.mock('@/components/ui/toast', () => ({}));

vi.stubGlobal('localStorage', { getItem: () => 'bot', setItem: vi.fn() });
const { useAppModeStore } = await import('@/stores/bots/mode');
const { sessionDeps } = await import('./PluginUiHost');

describe('PluginUiHost sessionDeps.focus', () => {
  beforeEach(() => {
    selected.length = 0;
    useAppModeStore.setState({ mode: 'bot' });
  });

  it('Bot 模式里跳到秘书或别的项目会话：切回 Code 视图并选中它', () => {
    sessionDeps.focus('sec', 'sec');
    expect(useAppModeStore.getState().mode).toBe('code');
    expect(selected).toEqual(['select:sec']);
  });

  it('子会话：切回 Code 视图、选中主会话后切到它的标签', () => {
    sessionDeps.focus('x9', 'x9::cw-1');
    expect(useAppModeStore.getState().mode).toBe('code');
    expect(selected).toEqual(['select:x9', 'tab:x9/x9::cw-1']);
  });
});
