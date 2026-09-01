import { useEffect, useRef } from 'react';
import { getXtermTheme } from '@/lib/ghosttyTheme';
import { attachTerminal, detachTerminal, updateTerminalAppearance } from '@/lib/terminalRegistry';
import { useSettingsStore } from '@/stores/settings';

interface TerminalViewProps {
  termId: string;
  cwd?: string;
  onTitle?: (title: string) => void;
}

/** 把 registry 里的 xterm host 挂进视图;切走只 detach,实例与 pty 都保留 */
export function TerminalView({ termId, cwd, onTitle }: TerminalViewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const terminalTheme = useSettingsStore((s) => s.terminalTheme);
  const fontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const fontSize = useSettingsStore((s) => s.terminalFontSize);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    let cancelled = false;
    let raf = 0;
    let observer: ResizeObserver | undefined;

    const tryAttach = () => {
      if (cancelled) return;
      if (!wrapper.isConnected || wrapper.clientWidth === 0) {
        raf = requestAnimationFrame(tryAttach);
        return;
      }
      const settings = useSettingsStore.getState();
      const instance = attachTerminal(termId, wrapper, {
        cwd: cwdRef.current,
        theme: getXtermTheme(settings.terminalTheme),
        fontFamily: settings.terminalFontFamily,
        fontSize: settings.terminalFontSize,
      });
      if (!instance.opened) {
        raf = requestAnimationFrame(tryAttach);
        return;
      }
      instance.onTitle = (title) => onTitleRef.current?.(title);
      const doFit = () => {
        if (!wrapper.isConnected || wrapper.clientWidth === 0) return;
        instance.fit.fit();
        void window.electronAPI.terminal.resize(termId, instance.term.cols, instance.term.rows);
      };
      doFit();
      void window.electronAPI.terminal.create({
        termId,
        cwd: cwdRef.current,
        cols: instance.term.cols,
        rows: instance.term.rows,
      });
      instance.term.focus();
      observer = new ResizeObserver(doFit);
      observer.observe(wrapper);
    };
    tryAttach();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      detachTerminal(termId);
    };
  }, [termId]);

  useEffect(() => {
    updateTerminalAppearance(getXtermTheme(terminalTheme), fontFamily, fontSize);
  }, [terminalTheme, fontFamily, fontSize]);

  return (
    <div
      ref={wrapperRef}
      className="h-full w-full overflow-hidden p-2"
      style={{ backgroundColor: getXtermTheme(terminalTheme)?.background }}
    />
  );
}
