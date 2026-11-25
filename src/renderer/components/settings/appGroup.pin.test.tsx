import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { setupPin } from './pin.testUtils';

/** 迁移时只改这里：分区 → 页面组件 */
async function APP_GROUP_PAGES() {
  const { GeneralSettings } = await import('./GeneralSettings');
  const { AppearanceSettings } = await import('./AppearanceSettings');
  const { ConversationSettings } = await import('./ConversationSettings');
  const { TerminalSettings } = await import('./TerminalSettings');
  const { RuntimeSettings } = await import('./RuntimeSettings');
  const { PrivacySettings } = await import('./PrivacySettings');
  const { DevToolsSection } = await import('./DevToolsSection');
  return {
    general: GeneralSettings,
    appearance: AppearanceSettings,
    conversation: ConversationSettings,
    terminal: TerminalSettings,
    runtime: RuntimeSettings,
    privacy: PrivacySettings,
    devTools: DevToolsSection,
  };
}

const pin = setupPin({
  pages: APP_GROUP_PAGES,
  results: {
    'electronAPI.compaction.getReserveTokens': 16384,
    'electronAPI.sourceAuthority.read': { projects: [], conversations: [] },
    'electronAPI.privacyMask.records': [],
    'electronAPI.window.shellIntegrationStatus': { installed: false },
  },
  props: { 'electronAPI.env.platform': 'darwin' },
});

describe('应用组设置迁移前后行为一致', () => {
  it('深链行 id 一个不少', () => {
    expect(pin.rows()).toMatchSnapshot();
  });

  it('每个控件的当前值（默认值）与读写的 store key / electronAPI 调用不变', async () => {
    expect(await pin.probe()).toMatchSnapshot();
  });

  it('展开所有折叠子项后同样不变（脱敏个人数据、背景图、自定义代理）', async () => {
    const state = pin.store.getState();
    await act(async () =>
      pin.store.setState({
        privacyMasking: {
          ...state.privacyMasking,
          enabled: true,
          personal: { ...state.privacyMasking.personal, enabled: true },
        },
        backgroundImageEnabled: true,
        proxyMode: 'custom',
      })
    );
    await pin.settle();
    expect(await pin.probe()).toMatchSnapshot();
  });
});
