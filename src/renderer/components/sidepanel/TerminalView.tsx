import { useEffect, useRef } from 'react';
import { getXtermTheme } from '@/lib/ghosttyTheme';
import { acquireTerminal, updateTerminalAppearance } from '@/lib/terminalRegistry';
import { useSettingsStore } from '@/stores/settings';

interface TerminalViewProps {
  termId: string;
  cwd?: string;
}

/** 把注册表里的 xterm 容器挂进视图;实例跨 tab/会话切换存活 */
export function TerminalView({ termId, cwd }: TerminalViewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  // cwd 只在 pty 首建时生效,用 ref 隔离出依赖列表
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const terminalTheme = useSettingsStore((s) => s.terminalTheme);
  const fontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const fontSize = useSettingsStore((s) => s.terminalFontSize);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    // 外观取当前快照即可:后续变化由下方 effect 广播,不让它们重建 pty 挂载
    const settings = useSettingsStore.getState();
    const instance = acquireTerminal(termId, {
      cwd: cwdRef.current,
      theme: getXtermTheme(settings.terminalTheme),
      fontFamily: settings.terminalFontFamily,
      fontSize: settings.terminalFontSize,
    });
    wrapper.appendChild(instance.container);

    const doFit = () => {
      if (!wrapper.isConnected || wrapper.clientWidth === 0) return;
      instance.fit.fit();
      void window.electronAPI.terminal.resize(termId, instance.term.cols, instance.term.rows);
    };
    doFit();
    instance.term.focus();
    const observer = new ResizeObserver(doFit);
    observer.observe(wrapper);
    return () => {
      observer.disconnect();
      // 容器留在注册表,unmount 只是摘下来
      instance.container.remove();
    };
  }, [termId]);

  useEffect(() => {
    updateTerminalAppearance(getXtermTheme(terminalTheme), fontFamily, fontSize);
  }, [terminalTheme, fontFamily, fontSize]);

  return <div ref={wrapperRef} className="h-full w-full overflow-hidden p-2" />;
}
