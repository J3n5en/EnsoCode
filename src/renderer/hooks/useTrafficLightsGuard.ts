import { useEffect } from 'react';

/**
 * macOS 红绿灯（红/黄/绿按钮）的模块级单例守卫。
 *
 * 任一模态框打开且窗口不处于全屏时隐藏红绿灯。
 * 使用引用计数，多个模态框同时打开时也能正确工作。
 *
 * 全屏监听在首次 acquire 时惰性初始化，并贯穿整个应用生命周期
 * （单个 Electron 窗口，随进程一起销毁）。HMR 场景下会先正确移除旧监听，
 * 再重新初始化，避免重复订阅。
 *
 * 注意：该守卫只对受控的 Dialog/AlertDialog（显式传入
 * `open` prop）生效。非受控用法（不传 `open`）不会触发守卫。
 *
 * 已知限制：如果组件异常卸载（例如卸载期间被 error boundary 捕获）
 * 且没有调用 releaseTrafficLightsGuard，guardCount 会泄漏，
 * 红绿灯可能一直隐藏，直到下次 HMR 重置或页面重新加载。
 * 实际中极少出现这种边界情况，因此没有实现全局恢复机制。
 */
let guardCount = 0;
let currentlyHidden = false;
let isFullScreen = false;
let listenerInitialized = false;
let cleanupFullScreenListener: (() => void) | null = null;

function resetModuleState() {
  guardCount = 0;
  currentlyHidden = false;
  isFullScreen = false;
  listenerInitialized = false;
  if (cleanupFullScreenListener) {
    cleanupFullScreenListener();
    cleanupFullScreenListener = null;
  }
}

function syncVisibility() {
  const shouldHide = guardCount > 0 && !isFullScreen;
  if (shouldHide === currentlyHidden) return;
  currentlyHidden = shouldHide;
  window.electronAPI?.window?.setTrafficLightsVisible(!shouldHide);
}

function initFullScreenListener() {
  if (listenerInitialized) return;
  listenerInitialized = true;

  window.electronAPI?.window
    ?.isFullScreen()
    .then((fs) => {
      isFullScreen = fs;
      syncVisibility();
    })
    .catch(() => {
      // 窗口正在销毁时 IPC 调用可能失败，可以安全忽略。
    });

  cleanupFullScreenListener =
    window.electronAPI?.window?.onFullScreenChange((fs) => {
      isFullScreen = fs;
      syncVisibility();
    }) ?? null;
}

export function acquireTrafficLightsGuard() {
  if (window.electronAPI?.env?.platform !== 'darwin') return;
  initFullScreenListener();
  guardCount++;
  syncVisibility();
}

export function releaseTrafficLightsGuard() {
  if (window.electronAPI?.env?.platform !== 'darwin') return;
  guardCount = Math.max(0, guardCount - 1);
  syncVisibility();
}

/**
 * Hook：`open` 为 true 时隐藏 macOS 红绿灯。
 * 由 Dialog/AlertDialog 的根组件包装自动调用。
 */
export function useTrafficLightsGuard(open: boolean) {
  useEffect(() => {
    if (!open) return;
    acquireTrafficLightsGuard();
    return () => releaseTrafficLightsGuard();
  }, [open]);
}

// HMR 时重置模块状态，避免残留的守卫计数和重复监听
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (currentlyHidden) {
      window.electronAPI?.window?.setTrafficLightsVisible(true);
    }
    resetModuleState();
  });
}
