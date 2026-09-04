import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { insertComposerText, requestFocusComposer } from '@/components/chat/composerMentionBridge';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useI18n } from '@/i18n';
import { getXtermTheme, withTransparentBackground } from '@/lib/ghosttyTheme';
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

/** 背景图模式下 xterm 自身不刷底色，由 wrapper 用应用底色 + 通用面板 alpha 刷一层 */
function resolveTerminalTheme(name: string, backgroundImageEnabled: boolean) {
  const theme = getXtermTheme(name);
  return backgroundImageEnabled ? withTransparentBackground(theme) : theme;
}

/** 把 registry 里的 xterm host 挂进视图;切走只 detach,实例与 pty 都保留 */
export function TerminalView({ termId, conversationId, projectId, onTitle }: TerminalViewProps) {
  const { t } = useI18n();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<ReturnType<typeof attachTerminal>['term'] | null>(null);
  const selectionRef = useRef('');
  const [hasSelection, setHasSelection] = useState(false);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const terminalTheme = useSettingsStore((s) => s.terminalTheme);
  const fontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const fontSize = useSettingsStore((s) => s.terminalFontSize);
  const bgImageEnabled = useSettingsStore((s) => s.backgroundImageEnabled);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    let cancelled = false;
    let raf = 0;
    let observer: ResizeObserver | undefined;

    const tryAttach = () => {
      if (cancelled) return;
      if (!wrapper.isConnected || wrapper.clientWidth === 0 || wrapper.clientHeight === 0) {
        raf = requestAnimationFrame(tryAttach);
        return;
      }
      const settings = useSettingsStore.getState();
      const instance = attachTerminal(termId, wrapper, {
        theme: resolveTerminalTheme(settings.terminalTheme, settings.backgroundImageEnabled),
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
      termRef.current = instance.term;
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
      termRef.current = null;
      detachTerminal(termId);
    };
  }, [termId]);

  useEffect(() => {
    updateTerminalAppearance(
      resolveTerminalTheme(terminalTheme, bgImageEnabled),
      fontFamily,
      fontSize
    );
  }, [terminalTheme, fontFamily, fontSize, bgImageEnabled]);

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

  const snapshotSelection = () => {
    const text = termRef.current?.getSelection().trim() ?? '';
    selectionRef.current = text;
    setHasSelection(text.length > 0);
  };

  const sendSelection = () => {
    const text = selectionRef.current || termRef.current?.getSelection().trim() || '';
    if (!text) return;
    insertComposerText(text);
    requestFocusComposer();
    termRef.current?.clearSelection();
    setHasSelection(false);
  };

  const copySelection = () => {
    const text = selectionRef.current || termRef.current?.getSelection().trim() || '';
    if (text) void navigator.clipboard.writeText(text);
  };

  const theme = getXtermTheme(terminalTheme);
  const pane = (
    <div
      ref={wrapperRef}
      data-slot="terminal-pane"
      className="relative h-full w-full overflow-hidden p-2"
      style={{
        backgroundColor: theme?.background,
        ['--terminal-bg' as string]: theme?.background,
      }}
      onContextMenu={snapshotSelection}
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

  return (
    <ContextMenu>
      <ContextMenuTrigger render={pane as ReactElement<Record<string, unknown>>} />
      <ContextMenuPopup className="min-w-40">
        <ContextMenuItem disabled={!hasSelection} onClick={copySelection}>
          {t('Copy')}
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasSelection} onClick={sendSelection}>
          {t('Send to conversation')}
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}
