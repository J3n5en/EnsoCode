import { useEffect } from 'react';

const WINDOWS_CHROME_CLASS = 'enso-win';
const WINDOWS_CHROME_FLUSH_CLASS = 'enso-win-flush';
const WINDOWS_CHROME_PENDING_CLASS = 'enso-win-pending';

interface WindowsChromeState {
  maximized: boolean;
  fullscreen: boolean;
}

/**
 * 状态事件可能先于初始 IPC 查询返回；已经收到事件的字段不能再被旧快照覆盖。
 */
function mergeInitialWindowsChromeState(
  current: WindowsChromeState,
  initial: WindowsChromeState,
  eventSeen: WindowsChromeState
): WindowsChromeState {
  return {
    maximized: eventSeen.maximized ? current.maximized : initial.maximized,
    fullscreen: eventSeen.fullscreen ? current.fullscreen : initial.fullscreen,
  };
}

/** 最大化或全屏时贴齐屏幕，去掉自绘圆角和描边。 */
function windowsChromeFlush(maximized: boolean, fullscreen: boolean): boolean {
  return maximized || fullscreen;
}

function applyWindowsChromeClasses(maximized: boolean, fullscreen: boolean): void {
  document.documentElement.classList.toggle(
    WINDOWS_CHROME_FLUSH_CLASS,
    windowsChromeFlush(maximized, fullscreen)
  );
}

/**
 * Windows 无框窗口自绘圆角和描边。
 * 只给 html 挂 class，样式在 globals.css；macOS / Linux 不跑。
 */
export function useWindowsWindowChrome(): void {
  useEffect(() => {
    if (window.electronAPI?.env.platform !== 'win32') return;

    const root = document.documentElement;
    root.classList.add(WINDOWS_CHROME_CLASS, WINDOWS_CHROME_PENDING_CLASS);

    let state: WindowsChromeState = { maximized: false, fullscreen: false };
    const eventRevision = { maximized: 0, fullscreen: 0 };
    let disposed = false;
    let queryRevision = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => applyWindowsChromeClasses(state.maximized, state.fullscreen);

    const api = window.electronAPI.window;
    const queryAndSync = () => {
      const revision = ++queryRevision;
      const eventRevisionAtQuery = { ...eventRevision };
      void Promise.all([api.isMaximized(), api.isFullScreen()])
        .then(([nextMaximized, nextFullscreen]) => {
          if (disposed || revision !== queryRevision) return;
          state = mergeInitialWindowsChromeState(
            state,
            { maximized: nextMaximized, fullscreen: nextFullscreen },
            {
              maximized: eventRevision.maximized !== eventRevisionAtQuery.maximized,
              fullscreen: eventRevision.fullscreen !== eventRevisionAtQuery.fullscreen,
            }
          );
          root.classList.remove(WINDOWS_CHROME_PENDING_CLASS);
          sync();
        })
        .catch(() => {
          // 窗口正在销毁时 IPC 可能失败
          if (!disposed && revision === queryRevision) {
            root.classList.remove(WINDOWS_CHROME_PENDING_CLASS);
          }
        });
    };
    queryAndSync();

    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(queryAndSync, 50);
    };
    window.addEventListener('resize', onResize);

    const offMaximized = api.onMaximizedChange((value) => {
      eventRevision.maximized += 1;
      state.maximized = value;
      sync();
    });
    const offFullscreen = api.onFullScreenChange((value) => {
      eventRevision.fullscreen += 1;
      state.fullscreen = value;
      sync();
    });

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      offMaximized();
      offFullscreen();
      root.classList.remove(
        WINDOWS_CHROME_CLASS,
        WINDOWS_CHROME_FLUSH_CLASS,
        WINDOWS_CHROME_PENDING_CLASS
      );
    };
  }, []);
}
