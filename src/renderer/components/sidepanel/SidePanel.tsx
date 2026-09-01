import type {
  DockviewApi,
  DockviewReadyEvent,
  IDockviewHeaderActionsProps,
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
  IWatermarkPanelProps,
} from 'dockview-react';
import { DockviewReact, themeDark, themeLight } from 'dockview-react';
import { motion } from 'framer-motion';
import { FolderOpen, GitCompare, Globe, Plus, SquareTerminal, X } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import { springStandard } from '@/lib/motion';
import { bindSidePanelDock } from '@/lib/sidePanelDock';
import { releaseTerminal } from '@/lib/terminalRegistry';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSidePanelStore } from '@/stores/sidePanel';
import { ChangesView } from './ChangesView';
import { FilesView } from './FilesView';
import { TerminalView } from './TerminalView';
import 'dockview-react/dist/styles/dockview.css';
import './sidepanel-dock.css';

/** dockview 的 part 组件在独立渲染树中,cwd 等上下文经 context 注入 */
const PanelContext = createContext<{ conversationId?: string; projectId?: string }>({});

function nextTerminalTitle(api: DockviewApi, label: string): string {
  const count = api.panels.length;
  return count === 0 ? label : `${label} ${count + 1}`;
}

function addTerminalPanel(
  api: DockviewApi,
  conversationId: string | undefined,
  projectId: string | undefined,
  label: string
): void {
  api.addPanel({
    id: crypto.randomUUID(),
    component: 'terminal',
    title: nextTerminalTitle(api, label),
    params: { conversationId, projectId },
  });
}

function addChangesPanel(
  api: DockviewApi,
  conversationId: string | undefined,
  projectId: string | undefined,
  label: string
): void {
  const existing = api.getPanel('changes');
  if (existing) {
    existing.focus();
    return;
  }
  api.addPanel({
    id: 'changes',
    component: 'changes',
    title: label,
    params: { conversationId, projectId },
  });
}

function TerminalPanel(
  props: IDockviewPanelProps<{ conversationId?: string; projectId?: string }>
) {
  return (
    <TerminalView
      termId={props.api.id}
      conversationId={props.params.conversationId}
      projectId={props.params.projectId}
      onTitle={(title) => props.api.setTitle(title)}
    />
  );
}

function ChangesPanel(props: IDockviewPanelProps<{ conversationId?: string; projectId?: string }>) {
  const { conversationId, projectId } = props.params;
  if (!conversationId || !projectId) return null;
  return <ChangesView conversationId={conversationId} projectId={projectId} />;
}

function addFilesPanel(
  api: DockviewApi,
  conversationId: string | undefined,
  projectId: string | undefined,
  label: string
): void {
  const existing = api.getPanel('files');
  if (existing) {
    existing.focus();
    return;
  }
  api.addPanel({
    id: 'files',
    component: 'files',
    title: label,
    params: { conversationId, projectId },
  });
}

function FilesPanel(props: IDockviewPanelProps<{ conversationId?: string; projectId?: string }>) {
  const { conversationId, projectId } = props.params;
  if (!conversationId || !projectId) return null;
  return <FilesView conversationId={conversationId} projectId={projectId} />;
}

/** 与 CoworkerTabs 同款 chip:圆角、bg-muted 激活、hover 出关闭 */
function SidePanelTab(props: IDockviewPanelHeaderProps) {
  const [active, setActive] = useState(props.api.isActive);
  const [title, setTitle] = useState(props.api.title ?? '');
  useEffect(() => {
    const a = props.api.onDidActiveChange(() => setActive(props.api.isActive));
    const t = props.api.onDidTitleChange(() => setTitle(props.api.title ?? ''));
    return () => {
      a.dispose();
      t.dispose();
    };
  }, [props.api]);
  return (
    <div
      className={cn(
        'group/tab relative flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
        active ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'
      )}
    >
      {props.api.id === 'changes' ? (
        <GitCompare className="h-3 w-3 shrink-0" />
      ) : props.api.id === 'files' ? (
        <FolderOpen className="h-3 w-3 shrink-0" />
      ) : (
        <SquareTerminal className="h-3 w-3 shrink-0" />
      )}
      <span className="max-w-32 truncate">{title}</span>
      <button
        type="button"
        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/tab:opacity-100"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          props.api.close();
        }}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function NewTabMenu({
  onNewTerminal,
  onNewChanges,
  onNewFiles,
  compact,
}: {
  onNewTerminal: () => void;
  onNewChanges: () => void;
  onNewFiles: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Menu>
      <MenuTrigger
        className={cn(
          'flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground',
          compact
            ? 'h-6 w-6 rounded p-1 hover:bg-muted'
            : 'h-8 gap-1.5 border border-dashed px-3 text-sm hover:border-solid'
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
        <MenuItem onClick={onNewChanges}>
          <GitCompare className="h-4 w-4" />
          {t('Changes')}
        </MenuItem>
        <MenuItem onClick={onNewFiles}>
          <FolderOpen className="h-4 w-4" />
          {t('Files')}
        </MenuItem>
        <MenuItem disabled>
          <Globe className="h-4 w-4" />
          {t('Browser')}
          <span className="ml-auto text-[10px] text-muted-foreground">{t('Soon')}</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** 空态水印:无任何 tab 时的新建入口 */
function Watermark(props: IWatermarkPanelProps) {
  const { t } = useI18n();
  const { conversationId, projectId } = useContext(PanelContext);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted-foreground">
        {t('No tabs yet. Create one to get started.')}
      </p>
      <NewTabMenu
        onNewTerminal={() =>
          addTerminalPanel(props.containerApi, conversationId, projectId, t('Terminal'))
        }
        onNewChanges={() =>
          addChangesPanel(props.containerApi, conversationId, projectId, t('Changes'))
        }
        onNewFiles={() => addFilesPanel(props.containerApi, conversationId, projectId, t('Files'))}
      />
    </div>
  );
}

/** 每个分组 tab 条右侧的 + 按钮:新 tab 落在该组 */
function GroupRightActions(props: IDockviewHeaderActionsProps) {
  const { t } = useI18n();
  const { conversationId, projectId } = useContext(PanelContext);
  return (
    <div className="flex h-full items-center">
      <NewTabMenu
        compact
        onNewTerminal={() => {
          props.containerApi.addPanel({
            id: crypto.randomUUID(),
            component: 'terminal',
            title: nextTerminalTitle(props.containerApi, t('Terminal')),
            params: { conversationId, projectId },
            position: { referenceGroup: props.group },
          });
        }}
        onNewChanges={() =>
          addChangesPanel(props.containerApi, conversationId, projectId, t('Changes'))
        }
        onNewFiles={() => addFilesPanel(props.containerApi, conversationId, projectId, t('Files'))}
      />
    </div>
  );
}

const DOCK_COMPONENTS = { terminal: TerminalPanel, changes: ChangesPanel, files: FilesPanel };

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

function ConversationDock({
  conversationId,
  projectId,
}: {
  conversationId: string;
  projectId: string;
}) {
  const isDark = useIsDark();

  const onReady = (event: DockviewReadyEvent) => {
    bindSidePanelDock(conversationId, event.api);
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
      if (panel.id === 'changes' || panel.id === 'files') return;
      releaseTerminal(panel.id);
      void window.electronAPI.terminal.dispose(panel.id);
    });
  };

  return (
    <PanelContext.Provider value={{ conversationId, projectId }}>
      <div className="enso-side-dock h-full">
        <DockviewReact
          components={DOCK_COMPONENTS}
          defaultTabComponent={SidePanelTab}
          watermarkComponent={Watermark}
          rightHeaderActionsComponent={GroupRightActions}
          theme={isDark ? themeDark : themeLight}
          onReady={onReady}
        />
      </div>
    </PanelContext.Provider>
  );
}

export function SidePanel({ width, resizing = false }: { width: number; resizing?: boolean }) {
  const { t } = useI18n();
  const open = useSidePanelStore((s) => s.open);
  const conversation = useSessionsStore((s) => (s.activeId ? s.conversations[s.activeId] : null));
  const conversations = useSessionsStore((s) => s.conversations);
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
        {visibleIds.length > 0 ? (
          <div className="relative min-h-0 flex-1">
            {visibleIds.map((id) => {
              const conv = conversations[id];
              return (
                <div key={id} className={cn('absolute inset-0', id !== activeId && 'hidden')}>
                  <ConversationDock conversationId={id} projectId={conv.projectId} />
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
