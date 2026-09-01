import { useCallback, useEffect, useRef, useState } from 'react';
import { getXtermTheme } from '@/lib/ghosttyTheme';
import {
  attachTerminal,
  clearTerminalSearch,
  detachTerminal,
  findInTerminal,
  updateTerminalAppearance,
} from '@/lib/terminalRegistry';
import { useSettingsStore } from '@/stores/settings';
import { TerminalSearchBar } from './TerminalSearchBar';

interface TerminalViewProps {
  termId: string;
  conversationId?: string;
  projectId?: string;
  onTitle?: (title: string) => void;
}

/** 把 registry 里的 xterm host 挂进视图;切走只 detach,实例与 pty 都保留 */
export function TerminalView({ termId, conversationId, projectId, onTitle }: TerminalViewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const terminalTheme = useSettingsStore((s) => s.terminalTheme);
  const fontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const fontSize = useSettingsStore((s) => s.terminalFontSize);
  const [searchOpen, setSearchOpen] = useState(false);

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
        conversationId: conversationIdRef.current,
        projectId: projectIdRef.current,
        cols: instance.term.cols,
        rows: instance.term.rows,
      });
      instance.term.focus();
      observer = new ResizeObserver(doFit);
      observer.observe(wrapper);
    };
    tryAttach();

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
      }
    };
    wrapper.addEventListener('keydown', onKey, true);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      wrapper.removeEventListener('keydown', onKey, true);
      detachTerminal(termId);
    };
  }, [termId]);

  useEffect(() => {
    updateTerminalAppearance(getXtermTheme(terminalTheme), fontFamily, fontSize);
  }, [terminalTheme, fontFamily, fontSize]);

  const findNext = useCallback(
    (query: string, options?: Parameters<typeof findInTerminal>[3]) =>
      findInTerminal(termId, query, 'next', options),
    [termId]
  );
  const findPrev = useCallback(
    (query: string, options?: Parameters<typeof findInTerminal>[3]) =>
      findInTerminal(termId, query, 'prev', options),
    [termId]
  );
  const clearSearch = useCallback(() => clearTerminalSearch(termId), [termId]);

  const theme = getXtermTheme(terminalTheme);

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full overflow-hidden p-2"
      style={{ backgroundColor: theme?.background }}
    >
      <TerminalSearchBar
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onFindNext={findNext}
        onFindPrevious={findPrev}
        onClear={clearSearch}
        theme={theme}
      />
    </div>
  );
}
