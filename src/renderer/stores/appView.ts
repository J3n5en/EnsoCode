import {
  relocateSettingsLink,
  type SettingsCategory,
  type SettingsDeepLink,
} from '@shared/settingsDeepLink';
import { create } from 'zustand';

/** 主窗口内的设置页。linkSeq 每来一条深链加一，同一链接重复打开也会再定位一次 */
export interface SettingsRoute {
  link: SettingsDeepLink | null;
  linkSeq: number;
}

interface AppViewState {
  /** null = 工作区 */
  settings: SettingsRoute | null;
  /** 不带深链再打开时回到这里 */
  lastCategory: SettingsCategory;
  /** 窄屏：分区详情（否则是导航列表） */
  mobileDetail: boolean;
  /** 工作区此刻被设置页盖住（含进出动画）：原生浏览器视图与面板快捷键据此让位 */
  workbenchCovered: boolean;
}

export const useAppViewStore = create<AppViewState>(() => ({
  settings: null,
  lastCategory: 'general',
  mobileDetail: false,
  workbenchCovered: false,
}));

export function openSettings(link?: SettingsDeepLink | null): void {
  useAppViewStore.setState((state) => {
    if (!link) return state.settings ? state : { settings: { link: null, linkSeq: 0 } };
    const target = relocateSettingsLink(link);
    return {
      settings: { link: target, linkSeq: (state.settings?.linkSeq ?? 0) + 1 },
      lastCategory: target.category,
      mobileDetail: true,
    };
  });
}

export function closeSettings(): void {
  useAppViewStore.setState({ settings: null, mobileDetail: false });
}

export function toggleSettings(): void {
  if (useAppViewStore.getState().settings) closeSettings();
  else openSettings();
}

export function setSettingsCategory(category: SettingsCategory): void {
  useAppViewStore.setState({ lastCategory: category });
}

export function setSettingsMobileDetail(mobileDetail: boolean): void {
  useAppViewStore.setState({ mobileDetail });
}

export function setWorkbenchCovered(workbenchCovered: boolean): void {
  if (useAppViewStore.getState().workbenchCovered !== workbenchCovered) {
    useAppViewStore.setState({ workbenchCovered });
  }
}

/** 浏览器历史深度：工作区 0，设置 1，窄屏分区详情 2 */
export function settingsHistoryDepth(
  state: Pick<AppViewState, 'settings' | 'mobileDetail'>,
  isMobile: boolean
): 0 | 1 | 2 {
  if (!state.settings) return 0;
  return isMobile && state.mobileDetail ? 2 : 1;
}

export const useSettingsOpen = (): boolean => useAppViewStore((s) => s.settings !== null);
export const useWorkbenchCovered = (): boolean => useAppViewStore((s) => s.workbenchCovered);
