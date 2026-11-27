import { offeredAgyModels, parseAgyModels } from '@shared/agy/catalog';
import type { AgyAuthStatus, AgyModelOption } from '@shared/agy/types';
import { create } from 'zustand';

interface AgyAuthState {
  status: AgyAuthStatus;
  /** Main 不探测给出的清单（含上次登录探测落盘的）；本窗口登录探测后跟随实时清单 */
  cachedModels: AgyModelOption[];
  setStatus: (status: AgyAuthStatus) => void;
}

export const useAgyAuthStore = create<AgyAuthState>((set) => ({
  status: { status: 'unknown' },
  cachedModels: [],
  setStatus: (status) =>
    set(status.status === 'signed-in' ? { status, cachedModels: status.models } : { status }),
}));

/** 与 Main 的 cachedAgyModels 同口径；「默认」由 agySettingsProvider 另补。 */
export function agyModelsFromState(
  state: Pick<AgyAuthState, 'status' | 'cachedModels'>
): AgyModelOption[] {
  return offeredAgyModels(state.status, state.cachedModels);
}

let bootstrapped = false;

/**
 * 每个 renderer root 挂一次：只读 Main 缓存，绝不探测（未登录的 agy 会反复开浏览器）。
 * 缓存晚到时若本窗口已有探测结果则丢弃；preload 缺出口时静默降级。
 */
export function bootstrapAgyModels(): void {
  if (bootstrapped) return;
  if (typeof window === 'undefined') return;
  const api = window.electronAPI?.agy;
  if (typeof api?.cachedModels !== 'function') return;
  bootstrapped = true;
  void api
    .cachedModels()
    .then((raw) => {
      if (useAgyAuthStore.getState().status.status !== 'unknown') return;
      useAgyAuthStore.setState({ cachedModels: parseAgyModels(raw) });
    })
    .catch(() => {});
}
