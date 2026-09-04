import { useEffect, useState } from 'react';

/**
 * Windows/Linux 自绘标题栏用：最大化后切还原图标。
 * Windows 上 unmaximize 通知可能丢，resize 后重查 isMaximized。
 */
export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const api = window.electronAPI?.window;
    if (!api) return;

    let disposed = false;
    let queryRevision = 0;
    let eventRevision = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    const query = () => {
      const revision = ++queryRevision;
      const eventRevisionAtQuery = eventRevision;
      void api
        .isMaximized()
        .then((value) => {
          if (disposed || revision !== queryRevision) return;
          if (eventRevision !== eventRevisionAtQuery) return;
          setMaximized(value);
        })
        .catch(() => {
          // 窗口正在销毁时 IPC 可能失败
        });
    };
    query();

    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(query, 50);
    };
    window.addEventListener('resize', onResize);

    const offMaximized = api.onMaximizedChange((value) => {
      eventRevision += 1;
      setMaximized(value);
    });

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      offMaximized();
    };
  }, []);

  return maximized;
}
