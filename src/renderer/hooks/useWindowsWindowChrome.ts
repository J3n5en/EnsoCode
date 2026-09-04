import { useEffect, useState } from 'react';

const WINDOWS_CHROME_CLASS = 'enso-win';
const WINDOWS_CHROME_FLUSH_CLASS = 'enso-win-flush';
const WINDOWS_CHROME_PENDING_CLASS = 'enso-win-pending';

interface WindowFrameState {
  maximized: boolean;
  fullscreen: boolean;
}

/**
 * 状态事件可能先于初始 IPC 查询返回；已经收到事件的字段不能再被旧快照覆盖。
 */
function mergeInitialWindowsChromeState(
  current: WindowFrameState,
  initial: WindowFrameState,
  eventSeen: WindowFrameState
): WindowFrameState {
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

function subscribeWindowFrameState(onChange: (state: WindowFrameState) => void): () => void {
  const api = window.electronAPI?.window;
  if (!api) return () => {};

  let state: WindowFrameState = { maximized: false, fullscreen: false };
  const eventRevision = { maximized: 0, fullscreen: 0 };
  let disposed = false;
  let queryRevision = 0;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  const emit = () => onChange(state);

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
        emit();
      })
      .catch(() => {
        // 窗口正在销毁时 IPC 可能失败
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
    emit();
  });
  const offFullscreen = api.onFullScreenChange((value) => {
    eventRevision.fullscreen += 1;
    state.fullscreen = value;
    emit();
  });

  return () => {
    disposed = true;
    if (resizeTimer) clearTimeout(resizeTimer);
    window.removeEventListener('resize', onResize);
    offMaximized();
    offFullscreen();
  };
}

/** Windows/Linux 自绘标题栏：最大化后切还原图标。 */
export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => subscribeWindowFrameState((state) => setMaximized(state.maximized)), []);
  return maximized;
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
    let ready = false;

    const stop = subscribeWindowFrameState((state) => {
      if (!ready) {
        ready = true;
        root.classList.remove(WINDOWS_CHROME_PENDING_CLASS);
      }
      applyWindowsChromeClasses(state.maximized, state.fullscreen);
    });

    return () => {
      stop();
      root.classList.remove(
        WINDOWS_CHROME_CLASS,
        WINDOWS_CHROME_FLUSH_CLASS,
        WINDOWS_CHROME_PENDING_CLASS
      );
    };
  }, []);
}
