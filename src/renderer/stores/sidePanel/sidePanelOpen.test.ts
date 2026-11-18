import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useSidePanelStore } from './index';

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: { getState: vi.fn() },
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: { getState: vi.fn() },
}));

function sessions(activeId: string) {
  vi.mocked(useSessionsStore.getState).mockReturnValue({
    activeId,
    conversations: {
      secretary: { projectId: 'sec' },
      normal: { projectId: 'code' },
    },
  } as unknown as ReturnType<typeof useSessionsStore.getState>);
}

describe('侧栏开关按会话独立', () => {
  beforeEach(() => {
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      projects: [
        { id: 'sec', kind: 'secretary' },
        { id: 'code', kind: 'project' },
      ],
    } as unknown as ReturnType<typeof useSettingsStore.getState>);
    useSidePanelStore.setState((state) => ({
      ...state,
      fullscreen: false,
      fullscreenByConversation: {},
      uiByConversation: {},
      layouts: {},
    }));
  });

  it('秘书侧栏全屏打开时，切到普通会话能独立打开侧栏', () => {
    sessions('secretary');
    useSidePanelStore.getState().toggleOpen();
    useSidePanelStore.getState().toggleFullscreen();

    sessions('normal');
    useSidePanelStore.getState().reconcileForActiveConversation();
    useSidePanelStore.getState().toggleOpen();

    const state = useSidePanelStore.getState();
    expect(state.uiByConversation.normal?.open).toBe(true);
    expect(state.fullscreen).toBe(false);
    expect(state.uiByConversation.secretary?.open).toBe(true);
    expect(state.fullscreenByConversation.secretary).toBe(true);
  });

  it('切回秘书时，秘书原来的全屏打开状态还在', () => {
    sessions('secretary');
    useSidePanelStore.getState().toggleOpen();
    useSidePanelStore.getState().toggleFullscreen();
    sessions('normal');
    useSidePanelStore.getState().reconcileForActiveConversation();
    useSidePanelStore.getState().toggleOpen();

    sessions('secretary');
    useSidePanelStore.getState().reconcileForActiveConversation();

    const state = useSidePanelStore.getState();
    expect(state.uiByConversation.secretary?.open).toBe(true);
    expect(state.fullscreen).toBe(true);
    expect(state.uiByConversation.normal?.open).toBe(true);
    expect(state.fullscreenByConversation.normal).toBe(false);
  });

  it('秘书侧栏关着时切走，切回来仍然关着', () => {
    sessions('secretary');
    sessions('normal');
    useSidePanelStore.getState().reconcileForActiveConversation();
    useSidePanelStore.getState().toggleOpen();

    sessions('secretary');
    useSidePanelStore.getState().reconcileForActiveConversation();

    const state = useSidePanelStore.getState();
    expect(state.uiByConversation.secretary?.open).toBeFalsy();
    expect(state.fullscreen).toBe(false);
    expect(state.uiByConversation.normal?.open).toBe(true);
  });
});
