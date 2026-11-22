import type { TerminalPalette } from '@enso/pair';
import type { Locale } from '@shared/i18n';
import { normalizeTimelinePrefs, type PairTimelinePrefs } from '@shared/pair/timelinePrefs';
import { DEFAULT_PRIVACY_MASK_SETTINGS } from '@shared/privacyMask/settings';
import { useSyncExternalStore } from 'react';
import type { SettingsState, Theme } from '../../../../src/renderer/stores/settings/types';

/**
 * `@/stores/settings` 的 PWA 桩：手机端不持有设置（provider/skill/project 都在桌面），
 * 只提供被复用的聊天组件真正读取的少数字段。类型沿用桌面定义避免漂移。
 * 经 vite alias 注入，桌面源码零改动。
 */

interface SettingsSlice
  extends PairTimelinePrefs,
    Pick<SettingsState, 'privacyMasking' | 'contextMenuOpen' | 'projects'> {
  language: Locale | 'system';
  theme: Theme;
  terminalTheme: string;
  terminalFontFamily: string;
  syncTerminalTheme: boolean;
  providers: never[];
  skills: never[];
  presets: never[];
  agentTypes: never[];
  loadLocalSkills: boolean;
  /** 桌面下发（appearance 帧）；缺省按开，与桌面默认一致 */
  compactReadOnlyTools: boolean;
  /** 桌面下发（appearance 帧）；缺省按开 */
  expandLiveEdits: boolean;
  /** Composer 切模型快捷键；手机不覆盖，走桌面默认 */
  keybindings: Record<string, string>;
}

let state: SettingsSlice = {
  language: 'system',
  // 手机端跟随系统深浅色（theme.ts 切 .dark class），此处给渲染组件一个确定值
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
  compactReadOnlyTools: true,
  expandLiveEdits: true,
  // 时间线折叠 / 待办条：appearance 帧到达前按桌面默认值
  ...normalizeTimelinePrefs({}),
  keybindings: {},
  // 脱敏在桌面出站时执行；Composer 直接解引用，缺省必须给全
  privacyMasking: DEFAULT_PRIVACY_MASK_SETTINGS,
  contextMenuOpen: [],
};

type Listener = (state: SettingsSlice, prev: SettingsSlice) => void;
const listeners = new Set<Listener>();
function setState(patch: Partial<SettingsSlice>): void {
  const prev = state;
  state = { ...state, ...patch };
  for (const l of listeners) l(state, prev);
}

/**
 * 桌面下发的终端配色。TerminalOutput 走 getXtermTheme(terminalTheme)，
 * 手机不打包主题库，故在 ghosttyTheme 桩里按这个已解析的调色板返回。
 */
let terminalPalette: TerminalPalette | undefined;

export function setTerminalAppearance(palette?: TerminalPalette, fontFamily?: string): void {
  terminalPalette = palette;
  // terminalTheme 只作为「是否有下发配色」的标记，实际取值走 getTerminalPalette
  setState({ terminalTheme: palette ? 'host' : '', terminalFontFamily: fontFamily ?? '' });
}

export function setCompactReadOnlyTools(enabled: boolean): void {
  if (state.compactReadOnlyTools !== enabled) setState({ compactReadOnlyTools: enabled });
}

export function setExpandLiveEdits(enabled: boolean): void {
  if (state.expandLiveEdits !== enabled) setState({ expandLiveEdits: enabled });
}

export function setTimelinePrefs(prefs: PairTimelinePrefs): void {
  const changed = (Object.keys(prefs) as (keyof PairTimelinePrefs)[]).some(
    (key) => state[key] !== prefs[key]
  );
  if (changed) setState(prefs);
}

/** 与 theme.ts 的 html.dark 对齐，供 pierre FileDiff 的 themeType 使用 */
export function setAppearanceTheme(theme: Theme, syncTerminalTheme: boolean): void {
  if (state.theme === theme && state.syncTerminalTheme === syncTerminalTheme) return;
  setState({ theme, syncTerminalTheme });
}

export function getTerminalPalette(): TerminalPalette | undefined {
  return terminalPalette;
}

const subscribe = (l: Listener): (() => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useSettingsStore<T>(selector: (s: SettingsSlice) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

useSettingsStore.getState = () => state;
useSettingsStore.subscribe = subscribe;
