import type {
  DockviewApi,
  DockviewReadyEvent,
  IDockviewHeaderActionsProps,
  IDockviewPanelProps,
  IWatermarkPanelProps,
} from 'dockview-react';
import { DockviewReact, themeDark, themeLight } from 'dockview-react';
import { motion } from 'framer-motion';
import { FolderOpen, Globe, PanelRightClose, Plus, SquareTerminal } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import { springStandard } from '@/lib/motion';
import { releaseTerminal } from '@/lib/terminalRegistry';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useSidePanelStore } from '@/stores/sidePanel';
import { TerminalView } from './TerminalView';
import 'dockview-react/dist/styles/dockview.css';

const ICON_BUTTON_CLASS =
  'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground';

/** dockview 的 part 组件在独立渲染树中,cwd 等上下文经 context 注入 */
const PanelContext = createContext<{ cwd?: string }>({});

function nextTerminalTitle(api: DockviewApi, label: string): string {
  const count = api.panels.length;
  return count === 0 ? label : `${label} ${count + 1}`;
}

function addTerminalPanel(api: DockviewApi, cwd: string | undefined, label: string): void {
  api.addPanel({
    id: crypto.randomUUID(),
    component: 'terminal',
    title: nextTerminalTitle(api, label),
    params: { cwd },
  });
}

function TerminalPanel(props: IDockviewPanelProps<{ cwd?: string }>) {
  return <TerminalView termId={props.api.id} cwd={props.params.cwd} />;
}

function NewTabMenu({ onNewTerminal, compact }: { onNewTerminal: () => void; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <Menu>
      <MenuTrigger
        className={cn(
          'flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground',
          compact ? 'h-7 w-7' : 'h-8 gap-1.5 border border-dashed px-3 text-sm hover:border-solid'
        )}
        aria-label={t('New tab')}
      >
        <Plus className="h-4 w-4" />
        {!compact && <span>{t('New tab')}</span>}
      </MenuTrigger>
      <MenuPopup align={compact ? 'end' : 'center'} className="min-w-36">
        <MenuItem onClick={onNewTerminal}>
          <SquareTerminal className="h-4 w-4" />
          {t('Terminal')}
        </MenuItem>
        {/* 预留:浏览器 / 文件,后续实现 */}
        <MenuItem disabled>
          <Globe className="h-4 w-4" />
          {t('Browser')}
          <span className="ml-auto text-[10px] text-muted-foreground">{t('Soon')}</span>
        </MenuItem>
        <MenuItem disabled>
          <FolderOpen className="h-4 w-4" />
          {t('Files')}
          <span className="ml-auto text-[10px] text-muted-foreground">{t('Soon')}</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** 空态水印:无任何 tab 时的新建入口 */
function Watermark(props: IWatermarkPanelProps) {
  const { t } = useI18n();
  const { cwd } = useContext(PanelContext);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted-foreground">
        {t('No tabs yet. Create one to get started.')}
      </p>
      <NewTabMenu onNewTerminal={() => addTerminalPanel(props.containerApi, cwd, t('Terminal'))} />
    </div>
  );
}

/** 每个分组 tab 条右侧的 + 按钮:新 tab 落在该组 */
function GroupRightActions(props: IDockviewHeaderActionsProps) {
  const { t } = useI18n();
  const { cwd } = useContext(PanelContext);
  return (
    <div className="flex h-full items-center pr-1">
      <NewTabMenu
        compact
        onNewTerminal={() => {
          props.containerApi.addPanel({
            id: crypto.randomUUID(),
            component: 'terminal',
            title: nextTerminalTitle(props.containerApi, t('Terminal')),
            params: { cwd },
            position: { referenceGroup: props.group },
          });
        }}
      />
    </div>
  );
}

const DOCK_COMPONENTS = { terminal: TerminalPanel };

/** 跟随应用暗色模式(applyAppTheme 切换 documentElement 的 dark class) */
function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setIsDark(document.documentElement.classList.contains('dark'))
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

function ConversationDock({ conversationId, cwd }: { conversationId: string; cwd?: string }) {
  const isDark = useIsDark();

  const onReady = (event: DockviewReadyEvent) => {
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__dockviewApi = event.api;
    }
    const saved = useSidePanelStore.getState().layouts[conversationId];
    if (saved) {
      try {
        event.api.fromJSON(saved);
      } catch {
        // 布局与当前版本不兼容:从空态开始
      }
    }
    event.api.onDidLayoutChange(() => {
      useSidePanelStore.getState().saveLayout(conversationId, event.api.toJSON());
    });
    // 只有用户关 tab 才回收;dock 本身不随切会话卸载
    event.api.onDidRemovePanel((panel) => {
      releaseTerminal(panel.id);
      void window.electronAPI.terminal.dispose(panel.id);
    });
  };

  return (
    <PanelContext.Provider value={{ cwd }}>
      <DockviewReact
        components={DOCK_COMPONENTS}
        watermarkComponent={Watermark}
        rightHeaderActionsComponent={GroupRightActions}
        theme={isDark ? themeDark : themeLight}
        onReady={onReady}
      />
    </PanelContext.Provider>
  );
}

export function SidePanel({ width, resizing = false }: { width: number; resizing?: boolean }) {
  const { t } = useI18n();
  const open = useSidePanelStore((s) => s.open);
  const toggleOpen = useSidePanelStore((s) => s.toggleOpen);
  const conversation = useSessionsStore((s) => (s.activeId ? s.conversations[s.activeId] : null));
  const conversations = useSessionsStore((s) => s.conversations);
  const projects = useSettingsStore((s) => s.projects);
  const [mountedIds, setMountedIds] = useState<string[]>([]);
  const activeId = conversation?.id;
  if (activeId && !mountedIds.includes(activeId)) {
    setMountedIds((ids) => (ids.includes(activeId) ? ids : [...ids, activeId]));
  }
  const visibleIds = mountedIds.filter((id) => conversations[id]);

  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? width : 0 }}
      transition={resizing ? { duration: 0 } : springStandard}
      className={cn('flex shrink-0 flex-col overflow-hidden bg-background/60', open && 'border-l')}
    >
      <div className={cn('flex h-full min-h-0 flex-col', !open && 'hidden')} style={{ width }}>
        <div className="flex items-center justify-end gap-1 border-b px-2 py-1">
          <button
            type="button"
            onClick={toggleOpen}
            className={ICON_BUTTON_CLASS}
            title={t('Collapse side panel')}
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>
        {visibleIds.length > 0 ? (
          <div className="relative min-h-0 flex-1">
            {visibleIds.map((id) => {
              const conv = conversations[id];
              const cwd =
                conv.worktree?.path ?? projects.find((p) => p.id === conv.projectId)?.path;
              return (
                <div key={id} className={cn('absolute inset-0', id !== activeId && 'hidden')}>
                  <ConversationDock conversationId={id} cwd={cwd} />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t('Select a conversation to use the side panel.')}
          </div>
        )}
      </div>
    </motion.aside>
  );
}
