import type { Locale } from '@shared/i18n';
import type { Theme } from '../../../../src/renderer/stores/settings/types';

/**
 * `@/stores/settings` 的 PWA 桩：手机端不持有设置（provider/skill/project 都在桌面），
 * 只提供被复用的聊天组件真正读取的少数字段。类型沿用桌面定义避免漂移。
 * 经 vite alias 注入，桌面源码零改动。
 */

interface SettingsSlice {
  language: Locale | 'system';
  theme: Theme;
  terminalTheme: string;
  terminalFontFamily: string;
  syncTerminalTheme: boolean;
  providers: never[];
  projects: never[];
  skills: never[];
  presets: never[];
  agentTypes: never[];
  loadLocalSkills: boolean;
}

const state: SettingsSlice = {
  language: 'system',
  // 手机端跟随系统深浅色（main.tsx 切 .dark class），此处给渲染组件一个确定值
  theme: 'system',
  terminalTheme: '',
  terminalFontFamily: '',
  syncTerminalTheme: false,
  providers: [],
  projects: [],
  skills: [],
  presets: [],
  agentTypes: [],
  loadLocalSkills: true,
};

export function useSettingsStore<T>(selector: (s: SettingsSlice) => T): T {
  return selector(state);
}

useSettingsStore.getState = () => state;
useSettingsStore.subscribe = () => () => {};
