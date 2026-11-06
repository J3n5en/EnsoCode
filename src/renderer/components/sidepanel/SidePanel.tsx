import { botBrowserChatId } from '@shared/bots/browser';
import { WINDOWS_CAPTION_BUTTONS_WIDTH } from '@shared/windowControls';
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
import {
  FolderOpen,
  GitCompare,
  Globe,
  Maximize2,
  MessageCircle,
  Minimize2,
  PanelRight,
  Plus,
  SquareTerminal,
  Workflow,
  X,
} from 'lucide-react';
import {
  createContext,
  type ReactElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useWindowChromeKind } from '@/components/app/WindowChrome';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { useIsMobile } from '@/hooks/useViewport';
import { useI18n } from '@/i18n';
import { holesClipPath } from '@/lib/backgroundClip';
import {
  addSidePanelBrowser,
  addSidePanelWorkflow,
  bindSidePanelDock,
  closeSidePanelBrowser,
  disposeConversationResources,
  selectWorkflowAvailable,
} from '@/lib/sidePanelDock';
import { releaseTerminal } from '@/lib/terminalRegistry';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useSidePanelStore } from '@/stores/sidePanel';
import { sanitizeSidePanelLayout } from '@/stores/sidePanel/layoutSanitize';
import {
  CHAT_MIN_WIDTH,
  resolveSidePanelWidth,
  SIDE_PANEL_GAP_WIDTH,
  SIDE_PANEL_HANDLE_WIDTH,
} from '@/stores/sidePanel/width';
import { useWorkflowRunsStore } from '@/stores/workflowRuns';
import { PluginIcon } from '../../plugins/PluginIcon';
import { PluginView } from '../../plugins/PluginView';
import { type PluginViewRef, usePluginViews } from '../../plugins/viewBridge';
import { BrowserView } from './BrowserView';
import { BtwView } from './BtwView';
import { ChangesView } from './ChangesView';
import { FilesView } from './FilesView';
import { shouldSkipSidePanelWidthAnim, sidePanelWidthTransition } from './sidePanelWidthAnim';
import { TerminalView } from './TerminalView';
import { idsToClose, type TabCloseKind } from './tabCloseActions';
import { WorkflowView } from './WorkflowView';
import 'dockview-react/dist/styles/dockview.css';
import './sidepanel-dock.css';

/** dockview 的 part 组件在独立渲染树中,cwd 等上下文经 context 注入 */
const PanelContext = createContext<{ conversationId?: string; projectId?: string }>({});
/** 面板升进窗口顶栏行：右上角那组 tab 条接管窗口顶栏的面板开关 */
const TitleRowContext = createContext(false);

/** 该组的 tab 条是否在 dock 右上角（分屏后只有它挨着窗口顶栏右端） */
function useIsTopRightGroup(
  containerApi: DockviewApi,
  group?: IDockviewHeaderActionsProps['group']
): boolean {
  const [topRight, setTopRight] = useState(!group);
  useEffect(() => {
    if (!group) return;
    const check = () => {
      const dock = group.element.closest('.dv-dockview')?.getBoundingClientRect();
      const box = group.element.getBoundingClientRect();
      setTopRight(
        !!dock && Math.abs(box.top - dock.top) < 1 && Math.abs(box.right - dock.right) < 1
      );
    };
    check();
    const sub = containerApi.onDidLayoutChange(check);
    return () => sub.dispose();
  }, [containerApi, group]);
  return topRight;
}

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

function addBtwPanel(
  api: DockviewApi,
  conversationId: string | undefined,
  projectId: string | undefined,
  label: string
): void {
  const count = api.panels.filter((panel) => panel.id.startsWith('btw:')).length;
  api.addPanel({
    id: `btw:${crypto.randomUUID()}`,
    component: 'btw',
    title: count === 0 ? label : `${label} ${count + 1}`,
    params: { conversationId, projectId },
  });
}

function BtwPanel(props: IDockviewPanelProps<{ conversationId?: string; projectId?: string }>) {
  const { conversationId } = props.params;
  if (!conversationId) return null;
  return <BtwView conversationId={conversationId} panelApi={props.api} />;
}

function addBrowserPanel(
  api: DockviewApi,
  conversationId: string | undefined,
  projectId: string | undefined,
  label: string,
  tabId?: string
): void {
  const id = tabId ?? `browser:${crypto.randomUUID()}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.focus();
    return;
  }
  api.addPanel({
    id,
    component: 'browser',
    title: label,
    params: { conversationId, projectId },
  });
}

function BrowserPanel(props: IDockviewPanelProps<{ conversationId?: string; projectId?: string }>) {
  const { conversationId } = props.params;
  if (!conversationId) return null;
  return <BrowserView conversationId={conversationId} panelApi={props.api} />;
}

function addWorkflowPanel(
  api: DockviewApi,
  conversationId: string | undefined,
  projectId: string | undefined,
  label: string
): void {
  const existing = api.getPanel('workflow');
  if (existing) {
    existing.focus();
    return;
  }
  api.addPanel({
    id: 'workflow',
    component: 'workflow',
    title: label,
    params: { conversationId, projectId },
  });
}

function useWorkflowAvailable(projectId: string | undefined): boolean {
  return useSettingsStore((state) => selectWorkflowAvailable(state, projectId));
}

function addPluginViewPanel(
  api: DockviewApi,
  conversationId: string | undefined,
  projectId: string | undefined,
  view: PluginViewRef,
  group?: IDockviewHeaderActionsProps['group']
): void {
  const id = `plugin:${view.pluginId}:${view.id}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.focus();
    return;
  }
  api.addPanel({
    id,
    component: 'plugin',
    title: view.title,
    params: { conversationId, projectId, pluginId: view.pluginId, viewId: view.id },
    renderer: 'always',
    ...(group ? { position: { referenceGroup: group } } : {}),
  });
}

function PluginViewPanel(
  props: IDockviewPanelProps<{ conversationId?: string; pluginId?: string; viewId?: string }>
) {
  const { conversationId, pluginId, viewId } = props.params;
  // 插件页面是 iframe，onlyWhenVisible 会在切走时把它移出文档，页面状态和播放都会丢
  useEffect(() => {
    if (props.api.renderer !== 'always') props.api.setRenderer('always');
  }, [props.api]);
  if (!pluginId || !viewId) return null;
  return <PluginView pluginId={pluginId} viewId={viewId} sessionId={conversationId ?? null} />;
}

function WorkflowPanel(
  props: IDockviewPanelProps<{ conversationId?: string; projectId?: string }>
) {
  const { conversationId } = props.params;
  if (!conversationId) return null;
  return <WorkflowView conversationId={conversationId} />;
}

function closeGroupTabs(
  api: IDockviewPanelHeaderProps['api'],
  kind: Exclude<TabCloseKind, 'saved'>
): void {
  const ordered = api.group.panels.map((panel) => panel.id);
  const closing = new Set(idsToClose(ordered, api.id, kind));
  for (const panel of [...api.group.panels]) {
    if (closing.has(panel.id)) panel.api.close();
  }
}

/** 与 CoworkerTabs 同款 chip:圆角、bg-muted 激活、hover 出关闭 */
function SidePanelTab(props: IDockviewPanelHeaderProps<{ favicon?: string | null }>) {
  const { t } = useI18n();
  const [active, setActive] = useState(props.api.isActive);
  const [title, setTitle] = useState(props.api.title ?? '');
  const [favicon, setFavicon] = useState<string | null>(props.params.favicon ?? null);
  const [faviconBroken, setFaviconBroken] = useState(false);
  useEffect(() => {
    const a = props.api.onDidActiveChange(() => setActive(props.api.isActive));
    const t = props.api.onDidTitleChange(() => setTitle(props.api.title ?? ''));
    const p = props.api.onDidParametersChange((params) => {
      const next =
        params && typeof params === 'object' && 'favicon' in params
          ? ((params as { favicon?: string | null }).favicon ?? null)
          : (props.api.getParameters()?.favicon ?? null);
      setFavicon(next ?? null);
      setFaviconBroken(false);
    });
    return () => {
      a.dispose();
      t.dispose();
      p.dispose();
    };
  }, [props.api]);
  const isBrowser = props.api.id === 'browser' || props.api.id.startsWith('browser:');
  const tab = (
    <div
      data-side-tab
      data-active={active || undefined}
      className={cn(
        'group/tab relative flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
        active ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'
      )}
    >
      {props.api.id === 'changes' ? (
        <GitCompare className="h-3 w-3 shrink-0" />
      ) : props.api.id === 'files' ? (
        <FolderOpen className="h-3 w-3 shrink-0" />
      ) : props.api.id.startsWith('btw:') ? (
        <MessageCircle className="h-3 w-3 shrink-0" />
      ) : props.api.id === 'workflow' ? (
        <Workflow className="h-3 w-3 shrink-0" />
      ) : props.api.id.startsWith('plugin:') ? (
        <PluginIcon pluginId={props.api.id.split(':')[1] ?? ''} className="h-3 w-3 shrink-0" />
      ) : isBrowser && favicon && !faviconBroken ? (
        <img
          src={favicon}
          alt=""
          className="h-3 w-3 shrink-0"
          onError={() => setFaviconBroken(true)}
        />
      ) : isBrowser ? (
        <Globe className="h-3 w-3 shrink-0" />
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
  return (
    <ContextMenu>
      <ContextMenuTrigger render={tab as ReactElement<Record<string, unknown>>} />
      <ContextMenuPopup className="min-w-40">
        <ContextMenuItem onClick={() => closeGroupTabs(props.api, 'self')}>
          {t('Close')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => closeGroupTabs(props.api, 'others')}>
          {t('Close others')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => closeGroupTabs(props.api, 'right')}>
          {t('Close tabs to the right')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => closeGroupTabs(props.api, 'all')}>
          {t('Close all')}
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

function NewTabMenu({
  onNewTerminal,
  onNewChanges,
  onNewFiles,
  onNewBrowser,
  onNewBtw,
  onNewWorkflow,
  onNewPluginView,
  compact,
}: {
  onNewTerminal: () => void;
  onNewChanges: () => void;
  onNewFiles: () => void;
  onNewBrowser: () => void;
  onNewBtw: () => void;
  /** 缺省 = 该项目没开 workflow 工具，不给入口 */
  onNewWorkflow?: () => void;
  onNewPluginView?: (view: PluginViewRef) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const pluginViews = usePluginViews();
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
        <MenuItem onClick={onNewBrowser}>
          <Globe className="h-4 w-4" />
          {t('Browser')}
        </MenuItem>
        <MenuItem onClick={onNewBtw}>
          <MessageCircle className="h-4 w-4" />
          {t('Btw')}
        </MenuItem>
        {onNewWorkflow ? (
          <MenuItem onClick={onNewWorkflow}>
            <Workflow className="h-4 w-4" />
            {t('Workflow')}
          </MenuItem>
        ) : null}
        {onNewPluginView
          ? pluginViews.map((view) => (
              <MenuItem key={`${view.pluginId}:${view.id}`} onClick={() => onNewPluginView(view)}>
                <PluginIcon pluginId={view.pluginId} className="h-4 w-4" />
                {view.title}
              </MenuItem>
            ))
          : null}
      </MenuPopup>
    </Menu>
  );
}

function SidePanelHeaderActions({
  containerApi,
  group,
}: {
  containerApi: DockviewApi;
  group?: IDockviewHeaderActionsProps['group'];
}) {
  const { t } = useI18n();
  const { conversationId, projectId } = useContext(PanelContext);
  const fullscreen = useSidePanelStore((s) => s.fullscreen);
  const toggleFullscreen = useSidePanelStore((s) => s.toggleFullscreen);
  const workflowAvailable = useWorkflowAvailable(projectId);
  const isMobile = useIsMobile();
  const titleRow = useContext(TitleRowContext);
  const topRight = useIsTopRightGroup(containerApi, group);
  const toggleOpen = useSidePanelStore((s) => s.toggleOpen);
  const windows = useWindowChromeKind() === 'windows';
  return (
    <div className="flex h-full items-center gap-0.5">
      <NewTabMenu
        compact
        onNewTerminal={() => {
          if (group) {
            containerApi.addPanel({
              id: crypto.randomUUID(),
              component: 'terminal',
              title: nextTerminalTitle(containerApi, t('Terminal')),
              params: { conversationId, projectId },
              position: { referenceGroup: group },
            });
            return;
          }
          addTerminalPanel(containerApi, conversationId, projectId, t('Terminal'));
        }}
        onNewChanges={() => addChangesPanel(containerApi, conversationId, projectId, t('Changes'))}
        onNewFiles={() => addFilesPanel(containerApi, conversationId, projectId, t('Files'))}
        onNewBrowser={() => addBrowserPanel(containerApi, conversationId, projectId, t('Browser'))}
        onNewBtw={() => {
          if (group) {
            const count = containerApi.panels.filter((panel) => panel.id.startsWith('btw:')).length;
            containerApi.addPanel({
              id: `btw:${crypto.randomUUID()}`,
              component: 'btw',
              title: count === 0 ? t('Btw') : `${t('Btw')} ${count + 1}`,
              params: { conversationId, projectId },
              position: { referenceGroup: group },
            });
            return;
          }
          addBtwPanel(containerApi, conversationId, projectId, t('Btw'));
        }}
        onNewWorkflow={
          workflowAvailable
            ? () => addWorkflowPanel(containerApi, conversationId, projectId, t('Workflow'))
            : undefined
        }
        onNewPluginView={(view) =>
          addPluginViewPanel(containerApi, conversationId, projectId, view, group)
        }
      />
      <button
        type="button"
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          isMobile && 'hidden'
        )}
        onClick={toggleFullscreen}
        aria-label={fullscreen ? t('Exit side panel fullscreen') : t('Expand side panel')}
        title={fullscreen ? t('Exit side panel fullscreen') : t('Expand side panel')}
      >
        {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
      </button>
      {titleRow && topRight && (
        <button
          type="button"
          className="ml-1 flex h-8 w-8 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted"
          onClick={toggleOpen}
          aria-label={t('Toggle side panel')}
          title={t('Toggle side panel')}
        >
          <PanelRight className="h-4 w-4" />
        </button>
      )}
      {titleRow && topRight && windows && (
        // 给 Windows 原生最小化/最大化/关闭让位（扣掉工作区 8px 右边距、tab 条右内边距与按钮间距）
        <span
          aria-hidden
          className="shrink-0"
          style={{
            width: `calc(100vw - env(titlebar-area-width, calc(100vw - ${WINDOWS_CAPTION_BUTTONS_WIDTH}px)) - 19px)`,
          }}
        />
      )}
    </div>
  );
}

/** 空态水印:无任何 tab 时的新建入口 */
function Watermark(props: IWatermarkPanelProps) {
  const { t } = useI18n();
  const { conversationId, projectId } = useContext(PanelContext);
  const workflowAvailable = useWorkflowAvailable(projectId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="enso-side-dock-header flex shrink-0 items-center justify-end border-b bg-background px-2 py-1">
        <SidePanelHeaderActions containerApi={props.containerApi} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-background px-6 text-center">
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
          onNewFiles={() =>
            addFilesPanel(props.containerApi, conversationId, projectId, t('Files'))
          }
          onNewBrowser={() =>
            addBrowserPanel(props.containerApi, conversationId, projectId, t('Browser'))
          }
          onNewBtw={() => addBtwPanel(props.containerApi, conversationId, projectId, t('Btw'))}
          onNewWorkflow={
            workflowAvailable
              ? () => addWorkflowPanel(props.containerApi, conversationId, projectId, t('Workflow'))
              : undefined
          }
          onNewPluginView={(view) =>
            addPluginViewPanel(props.containerApi, conversationId, projectId, view)
          }
        />
      </div>
    </div>
  );
}

/** 每个分组 tab 条右侧的 + 按钮:新 tab 落在该组 */
function GroupRightActions(props: IDockviewHeaderActionsProps) {
  return <SidePanelHeaderActions containerApi={props.containerApi} group={props.group} />;
}

const DOCK_COMPONENTS = {
  terminal: TerminalPanel,
  changes: ChangesPanel,
  files: FilesPanel,
  browser: BrowserPanel,
  btw: BtwPanel,
  workflow: WorkflowPanel,
  plugin: PluginViewPanel,
};

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

function MountedConversationDock({
  conversationId,
  hidden,
}: {
  conversationId: string;
  hidden: boolean;
}) {
  const projectId = useSessionsStore((s) => s.conversations[conversationId]?.projectId);
  if (!projectId) return null;
  return (
    <div className={cn('absolute inset-0', hidden && 'hidden')}>
      <ConversationDock conversationId={conversationId} projectId={projectId} />
    </div>
  );
}

function ConversationDock({
  conversationId,
  projectId,
}: {
  conversationId: string;
  projectId: string;
}) {
  const isDark = useIsDark();
  const workflowAvailable = useWorkflowAvailable(projectId);
  const [dockApi, setDockApi] = useState<DockviewApi | null>(null);
  // 关掉工具时收起已开的工作流 tab；恢复布局带回来的也一并收掉
  useEffect(() => {
    if (!workflowAvailable) dockApi?.getPanel('workflow')?.api.close();
  }, [dockApi, workflowAvailable]);

  const onReady = (event: DockviewReadyEvent) => {
    bindSidePanelDock(conversationId, event.api);
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__dockviewApi = event.api;
    }
    const saved = useSidePanelStore.getState().layouts[conversationId];
    const layout = sanitizeSidePanelLayout(saved, new Set(Object.keys(DOCK_COMPONENTS)));
    let ignoreEmptySave = Boolean(saved) && !layout;
    if (layout) {
      try {
        event.api.fromJSON(layout);
      } catch {
        // 布局与当前版本不兼容:从空态开始，且不要把空 dock 写回把旧布局盖掉
        ignoreEmptySave = true;
      }
    }
    event.api.onDidLayoutChange(() => {
      const json = event.api.toJSON();
      if (ignoreEmptySave && Object.keys(json.panels ?? {}).length === 0) return;
      ignoreEmptySave = false;
      useSidePanelStore.getState().saveLayout(conversationId, json);
    });
    // 只有用户关 tab 才回收;dock 本身不随切会话卸载
    event.api.onDidRemovePanel((panel) => {
      if (panel.id === 'changes' || panel.id === 'files' || panel.id.startsWith('plugin:')) return;
      if (panel.id === 'browser' || panel.id.startsWith('browser:')) {
        void window.electronAPI.browser.closeTab(panel.id);
        return;
      }
      if (panel.id.startsWith('btw:')) {
        void useSessionsStore.getState().disposeBtwConversation(panel.id.slice(4));
        return;
      }
      releaseTerminal(panel.id);
      void window.electronAPI.terminal.dispose(panel.id);
    });
    setDockApi(event.api);
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

export function SidePanel({
  width: preferredWidth,
  resizing = false,
  card = false,
  titleRow = false,
}: {
  width: number;
  resizing?: boolean;
  /** 桌面外壳：做成浮在画布上的圆角卡片 */
  card?: boolean;
  /** mac 桌面外壳：并排时不做卡片，贴右/下边并伸进顶栏行，tab 条与顶栏齐平、左边线即分割 */
  titleRow?: boolean;
}) {
  const { t } = useI18n();
  const activeIdForUi = useSessionsStore((s) => s.activeId);
  const open = useSidePanelStore((s) =>
    activeIdForUi ? Boolean(s.uiByConversation[activeIdForUi]?.open) : false
  );
  // 窄屏没有并排空间：打开即全屏盖住聊天区
  const isMobile = useIsMobile();
  const storeFullscreen = useSidePanelStore((s) => s.fullscreen);
  const fullscreen = storeFullscreen || (isMobile && open);
  useEffect(() => {
    const stopReveal = window.electronAPI.browser.onReveal((event) => {
      if (botBrowserChatId(event.conversationId)) return;
      addSidePanelBrowser({
        conversationId: event.conversationId,
        tabId: event.tabId,
      });
    });
    const stopClosed = window.electronAPI.browser.onTabClosed((event) => {
      closeSidePanelBrowser(event.conversationId, event.tabId);
    });
    void window.electronAPI.browser.restoreTabs();
    return () => {
      stopReveal();
      stopClosed();
    };
  }, []);
  useEffect(
    () =>
      useWorkflowRunsStore.subscribe((state, prev) => {
        for (const [conversationId, runs] of Object.entries(state.byConversation)) {
          if (prev.byConversation[conversationId] === runs) continue;
          const started = runs.find((run) => run.status === 'running');
          if (!started) continue;
          addSidePanelWorkflow({
            conversationId,
            runId: started.runId,
            title: t('Workflow'),
          });
        }
      }),
    [t]
  );
  useEffect(
    () =>
      useSessionsStore.subscribe((state, prev) => {
        for (const id of Object.keys(prev.conversations)) {
          if (!state.conversations[id]) disposeConversationResources(id);
        }
      }),
    []
  );
  const conversationId = useSessionsStore((s) => s.activeId);
  const [mountedIds, setMountedIds] = useState<string[]>([]);
  const visibleKey = useSessionsStore((s) =>
    mountedIds.filter((id) => Boolean(s.conversations[id])).join('\n')
  );
  const [cover, setCover] = useState(fullscreen);
  const [workspaceW, setWorkspaceW] = useState(0);
  const handleW = card && !titleRow ? SIDE_PANEL_GAP_WIDTH : SIDE_PANEL_HANDLE_WIDTH;
  const width = resolveSidePanelWidth(preferredWidth, workspaceW, handleW);
  const asideRef = useRef<HTMLElement>(null);
  const [widthAnim, setWidthAnim] = useState({
    id: conversationId,
    from: conversationId,
  });
  if (conversationId !== widthAnim.id) {
    setWidthAnim({ id: conversationId, from: widthAnim.id });
  }
  if (fullscreen && !cover) setCover(true);
  useEffect(() => {
    const parent = asideRef.current?.parentElement;
    if (!parent) return;
    const update = () => {
      const style = getComputedStyle(parent);
      setWorkspaceW(
        parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (widthAnim.from === widthAnim.id) return;
    setWidthAnim((s) => (s.from === s.id ? s : { ...s, from: s.id }));
  }, [widthAnim.from, widthAnim.id]);
  /**
   * 内容层固定为目标宽度、左对齐，而不是 w-full 跟随 aside：
   * dockview 的 resize 回调在 ResizeObserver 里又套了一层 rAF，至少滞后一帧；
   * aside 展开态是透明的（给 Browser 挖孔），若内容跟着 aside 逐帧重排，
   * 弹簧过冲/打开首帧时 aside 比内容宽出来的那一条就会露出没有面板遮罩的裸壁纸。
   * 全屏 cover 态 aside 本身是实底，内容照常铺满。非卡片态 border-l 占 1px，内容按 content-box 扣掉。
   */
  const contentW = cover ? undefined : Math.max(0, width - (open && !card ? 1 : 0));
  const activeId = conversationId;
  const skipWidthAnim = shouldSkipSidePanelWidthAnim({
    resizing,
    conversationId: widthAnim.id ?? undefined,
    previousConversationId: widthAnim.from ?? undefined,
  });
  const targetW = fullscreen ? workspaceW || width : open ? width : 0;
  const inTitleRow = Boolean(titleRow) && !isMobile;
  if (activeId && !mountedIds.includes(activeId)) {
    setMountedIds((ids) => (ids.includes(activeId) ? ids : [...ids, activeId]));
  }
  const visibleIds = visibleKey === '' ? [] : visibleKey.split('\n');

  return (
    <>
      {cover && !isMobile ? <div className="shrink-0" style={{ width }} aria-hidden /> : null}
      <motion.aside
        ref={asideRef}
        data-slot="side-panel"
        initial={false}
        animate={{ width: targetW }}
        // 定位走内联：主题 CSS 常给 [data-enso="side-panel"] 写 position:relative 挂角标，会压过 absolute 类，全屏就铺不开
        style={
          cover
            ? { position: 'absolute' }
            : {
                position: 'relative',
                maxWidth: `max(0px, calc(100% - ${CHAT_MIN_WIDTH + handleW}px))`,
              }
        }
        transition={sidePanelWidthTransition({ skip: skipWidthAnim, cover, targetW })}
        onAnimationComplete={() => {
          if (!fullscreen) setCover(false);
        }}
        className={cn(
          'flex min-h-0 flex-col',
          // 顶栏态的描边/阴影画在盒外，放宽 4px 裁剪才能和对话卡片底边、右边一致；
          // 关着时不放宽：dockview 的 .dv-view.visible 会顶掉外层 invisible，内容会从余量里漏出一条
          inTitleRow && open ? 'overflow-clip [overflow-clip-margin:4px]' : 'overflow-hidden',
          // 平时透明让底层挖孔透出 guest；全屏盖在 ChatView 上、收起动画中必须实底
          open && (inTitleRow || !cover) ? 'bg-transparent' : inTitleRow ? '' : 'bg-background',
          !cover
            ? 'shrink-0'
            : inTitleRow
              ? 'top-px right-[8px] bottom-[8px]'
              : !card
                ? 'inset-y-0 right-0'
                : 'top-0 right-[8px] bottom-[8px]',
          inTitleRow
            ? cn('no-drag -mt-[44px]', cover ? 'rounded-b-[10px]' : 'rounded-br-[10px]')
            : card
              ? cn('rounded-[10px]', open && 'shadow-surface')
              : open && 'border-l'
        )}
        data-enso="side-panel"
        data-title-row={inTitleRow || undefined}
      >
        {open && (inTitleRow || !cover) ? (
          <SurfaceUnderHoles titleRow={inTitleRow} full={cover} />
        ) : null}
        {open && !cover && contentW !== undefined ? (
          // 过冲补条：只盖 [内容右边缘, aside 右边缘]，稳态宽度为 0，不会压到 Browser 挖孔
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute right-0 bottom-0 bg-background',
              titleRow ? 'top-[44px]' : 'top-0'
            )}
            style={{ left: contentW }}
          />
        ) : null}
        <div
          className={cn(
            'relative flex h-full min-h-0 flex-col',
            cover && 'w-full',
            // invisible 而非 hidden：关着时 dockview 也按目标宽度排好，打开首帧即满遮罩
            !open && 'invisible'
          )}
          style={{
            width: contentW,
            // 顶栏态：面板内容自带实底，挖出卡片面（y=44 起）的圆角；全屏时左侧没有接缝，四角都圆
            clipPath: inTitleRow ? (cover ? TITLE_ROW_FULL_CLIP : TITLE_ROW_SEAM_CLIP) : undefined,
          }}
        >
          {visibleIds.length > 0 ? (
            <div className="relative min-h-0 flex-1">
              <TitleRowContext.Provider value={inTitleRow}>
                {visibleIds.map((id) => (
                  <MountedConversationDock key={id} conversationId={id} hidden={id !== activeId} />
                ))}
              </TitleRowContext.Provider>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t('Select a conversation to use the side panel.')}
            </div>
          )}
        </div>
      </motion.aside>
    </>
  );
}

/**
 * 展开态面板底色：BackgroundLayer 现在铺的是画布色，面板自己铺卡片底，
 * 同样按视口坐标挖掉 Browser guest 的矩形，guest 沉底时才能透出。
 */
const TITLE_ROW_SEAM_CLIP =
  'shape(from 0 0, hline to 100%, vline to 44px, hline to calc(100% - 10px), arc to 100% 54px of 10px cw, vline to calc(100% - 10px), arc to calc(100% - 10px) 100% of 10px cw, hline to 0, close)';
const TITLE_ROW_FULL_CLIP =
  'shape(from 0 0, hline to 100%, vline to 44px, hline to calc(100% - 10px), arc to 100% 54px of 10px cw, vline to calc(100% - 10px), arc to calc(100% - 10px) 100% of 10px cw, hline to 10px, arc to 0 calc(100% - 10px) of 10px cw, vline to 54px, arc to 10px 44px of 10px cw, hline to 0, close)';

function SurfaceUnderHoles({ titleRow, full }: { titleRow: boolean; full: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const holes = useSidePanelStore((s) => s.browserHoles);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { left, top } = el.getBoundingClientRect();
    const local = Object.values(holes).map((h) => ({ ...h, x: h.x - left, y: h.y - top }));
    el.style.clipPath = holesClipPath(local) ?? '';
  }, [holes]);
  return (
    <>
      {/* 顶栏态：tab 条透明落在画布上，卡片面只从 44px 起；阴影单独画并裁掉接缝一侧 */}
      {titleRow && (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-0 top-[44px] bottom-0 shadow-surface',
            full ? 'rounded-[10px]' : 'rounded-r-[10px]'
          )}
          style={full ? undefined : { clipPath: 'inset(-24px -24px -24px 0)' }}
        />
      )}
      <div
        ref={ref}
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 bg-background',
          titleRow ? cn('top-[44px]', full ? 'rounded-[10px]' : 'rounded-r-[10px]') : 'top-0'
        )}
      />
    </>
  );
}
