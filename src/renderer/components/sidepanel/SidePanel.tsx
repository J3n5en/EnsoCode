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
  LayoutGrid,
  Maximize2,
  MessageCircle,
  Minimize2,
  Pin,
  Plus,
  SquareTerminal,
  Workflow,
  X,
} from 'lucide-react';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useWindowChromeKind } from '@/components/app/WindowChrome';
import { useSecretaryName } from '@/components/secretary/useSecretaryFace';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { useIsMobile } from '@/hooks/useViewport';
import { useI18n } from '@/i18n';
import { holesClipPath } from '@/lib/backgroundClip';
import { isRemoteClient } from '@/lib/remoteClient';
import {
  addSidePanelBrowser,
  addSidePanelWorkflow,
  bindLiveGlobalTabs,
  bindSidePanelDock,
  closeSidePanelBrowser,
  disposeConversationResources,
  selectIsSecretaryProject,
  selectWorkflowAvailable,
  setPluginPanelScope,
  syncDockGlobalTabs,
  unbindSidePanelDock,
  watchGlobalTabs,
  watchSidePanelAutoCollapse,
} from '@/lib/sidePanelDock';
import { releaseTerminal } from '@/lib/terminalInstances';
import { cn } from '@/lib/utils';
import { useSettingsOpen } from '@/stores/appView';
import { setLayoutAnimating, useLayoutAnimationStore } from '@/stores/layoutAnimation';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import {
  type PinnableSidePanelTab,
  useSidePanelShown,
  useSidePanelStore,
} from '@/stores/sidePanel';
import { resolvePanelScope } from '@/stores/sidePanel/globalTabs';
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
import { type PluginViewRef, usePluginViews, usePluginViewsReady } from '../../plugins/viewBridge';
import { SecretaryPanel } from '../secretary/SecretaryPanel';
import { BrowserView } from './BrowserView';
import { BtwView } from './BtwView';
import { restoreHostBrowserTabs } from './browserTabs';
import { ChangesView } from './ChangesView';
import { FilesView } from './FilesView';
import { GlobalPluginLayer, GlobalPluginSlot } from './GlobalPluginLayer';
import { headerActionsPinned, headerNewTabPromptAt, newTabAutoPopOpen } from './newTabPromptGate';
import { overflowTabList, removeOverflowRows, snapshotOverflowRows } from './overflowTabClose';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import { type PanelActivitySource, PanelVisibilityProvider } from './panelVisibility';
import { isPluginPanelId, pinnableTabForId, planPinnedPanels } from './pinnedTabs';
import { addSecretaryPanel, createSecretaryConsoleReveal } from './secretaryConsole';
import { secretaryPluginPanelsToClose, secretaryPluginViews } from './secretaryPluginViews';
import { sidePanelCoversMain } from './sidePanelCover';
import {
  SIDE_ACTIONS_EXTRA_CLASS,
  SidePanelCloseButton,
  SidePanelCollapseButton,
} from './sidePanelHeaderClose';
import { SidePanelTabShell } from './sidePanelTabShell';
import { liftsIntoTitleRow } from './sidePanelTitleRow';
import { shouldSkipSidePanelWidthAnim, sidePanelWidthTransition } from './sidePanelWidthAnim';
import { ShowEverywhereItem, SideTabTitle } from './sideTabScope';
import { TerminalView } from './TerminalView';
import { idsToClose, type TabCloseKind } from './tabCloseActions';
import { WorkflowView } from './WorkflowView';
import 'dockview-react/dist/styles/dockview.css';
import './sidepanel-dock.css';

/** dockview 的 part 组件在独立渲染树中,cwd 等上下文经 context 注入 */
const PanelContext = createContext<{ conversationId?: string; projectId?: string }>({});
/** 面板升进窗口顶栏行：右上角那组 tab 条接管窗口顶栏的面板开关 */
const TitleRowContext = createContext(false);

/** dock 按会话常驻，隐藏会话的面板仍挂载：把「此面板是否在屏幕上」交给子视图，供快捷键与轮询门控 */
function VisiblePanel({ api, children }: { api: PanelActivitySource; children: ReactNode }) {
  const { conversationId } = useContext(PanelContext);
  if (!conversationId) return children;
  return (
    <PanelVisibilityProvider dockConversationId={conversationId} api={api}>
      {children}
    </PanelVisibilityProvider>
  );
}

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
  return (
    <VisiblePanel api={props.api}>
      <ChangesView conversationId={conversationId} projectId={projectId} />
    </VisiblePanel>
  );
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
  return (
    <VisiblePanel api={props.api}>
      <FilesView conversationId={conversationId} projectId={projectId} />
    </VisiblePanel>
  );
}

function addBtwPanel(
  api: DockviewApi,
  conversationId: string | undefined,
  projectId: string | undefined,
  label: string,
  tabId?: string
): void {
  const count = api.panels.filter((panel) => panel.id.startsWith('btw:')).length;
  api.addPanel({
    id: tabId ?? `btw:${crypto.randomUUID()}`,
    component: 'btw',
    title: count === 0 ? label : `${label} ${count + 1}`,
    params: { conversationId, projectId },
  });
}

function BtwPanel(
  props: IDockviewPanelProps<{ conversationId?: string; projectId?: string; learn?: boolean }>
) {
  const { conversationId, learn } = props.params;
  if (!conversationId) return null;
  return <BtwView conversationId={conversationId} panelApi={props.api} learn={learn === true} />;
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
  return (
    <VisiblePanel api={props.api}>
      <BrowserView conversationId={conversationId} panelApi={props.api} />
    </VisiblePanel>
  );
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

function Secretary(props: IDockviewPanelProps<{ conversationId?: string; projectId?: string }>) {
  return (
    <VisiblePanel api={props.api}>
      <SecretaryPanel projectId={props.params.projectId} />
    </VisiblePanel>
  );
}

function useWorkflowAvailable(projectId: string | undefined): boolean {
  return useSettingsStore((state) => selectWorkflowAvailable(state, projectId));
}

/** 秘书会话只留浏览器、秘书面板与勾选插件的页面；开关关掉时与普通会话一样 */
function useSecretaryConversation(projectId: string | undefined): boolean {
  return useSettingsStore(
    (state) => state.secretaryEnabled && selectIsSecretaryProject(state.projects, projectId)
  );
}

const NO_PLUGINS: readonly string[] = [];

/** 秘书设置里勾选的插件 id；档案还没到时为 null */
function useSecretaryPluginIds(): readonly string[] | null {
  return useSecretaryStore((state) =>
    state.secretary.profile ? (state.secretary.profile.pluginIds ?? NO_PLUGINS) : null
  );
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
  const dockConversationId = useContext(PanelContext).conversationId;
  const global = useSidePanelStore((s) => s.liveGlobalTabs.includes(props.api.id));
  // 插件页面是 iframe，onlyWhenVisible 会在切走时把它移出文档，页面状态和播放都会丢。
  // 全局页面的占位块也保持 always：对未激活面板 setRenderer 会让 dockview 把它塞进分组内容区，打乱标签显示
  useEffect(() => {
    if (props.api.renderer !== 'always') props.api.setRenderer('always');
  }, [props.api]);
  if (!pluginId || !viewId) return null;
  // 全局页面只有一个常驻实例（GlobalPluginLayer），这里只放占位块
  if (global && dockConversationId) {
    return (
      <GlobalPluginSlot
        panelId={props.api.id}
        conversationId={dockConversationId}
        api={props.api}
        containerApi={props.containerApi}
      />
    );
  }
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
): string[] {
  const ordered = api.group.panels.map((panel) => panel.id);
  const closing = new Set(idsToClose(ordered, api.id, kind));
  const closed: string[] = [];
  for (const panel of [...api.group.panels]) {
    if (!closing.has(panel.id)) continue;
    panel.api.close();
    closed.push(panel.id);
  }
  return closed;
}

/** 内置面板的「在所有会话中显示」= 固定标签：各会话各自一份实例 */
const SHAREABLE_BUILTIN = new Set<PinnableSidePanelTab>(['terminal', 'changes', 'files', 'btw']);
const pinnedFillListeners = new Set<(tab: PinnableSidePanelTab) => void>();

/** 刚固定的内置标签同时补进所有已挂载的会话 */
function fillPinnedEverywhere(tab: PinnableSidePanelTab): void {
  for (const listener of pinnedFillListeners) listener(tab);
}

/** 与 CoworkerTabs 同款 chip:圆角、bg-muted 激活、hover 出关闭 */
export function SidePanelTab(props: IDockviewPanelHeaderProps<{ favicon?: string | null }>) {
  const { t } = useI18n();
  const { conversationId } = useContext(PanelContext);
  const tabNode = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(props.api.isActive);
  const [title, setTitle] = useState(props.api.title ?? '');
  const [favicon, setFavicon] = useState<string | null>(props.params.favicon ?? null);
  const [faviconBroken, setFaviconBroken] = useState(false);
  const pinnedTabs = useSidePanelStore((state) => state.pinnedTabs);
  const togglePinnedTab = useSidePanelStore((state) => state.togglePinnedTab);
  const pinnableTab = pinnableTabForId(props.api.id);
  const pinned = pinnableTab ? pinnedTabs.includes(pinnableTab) : false;
  const pluginViews = usePluginViews();
  const scopeOverrides = useSidePanelStore((state) => state.globalScopeOverrides);
  const liveGlobal = useSidePanelStore((state) => state.liveGlobalTabs.includes(props.api.id));
  const pluginPanel = isPluginPanelId(props.api.id);
  const shareable = pluginPanel
    ? pluginViews.some((view) => `plugin:${view.pluginId}:${view.id}` === props.api.id)
    : pinnableTab !== undefined && SHAREABLE_BUILTIN.has(pinnableTab);
  const shared = pluginPanel
    ? resolvePanelScope(props.api.id, scopeOverrides, pluginViews) === 'global'
    : pinned;
  const toggleShared = () => {
    if (pluginPanel) {
      if (conversationId)
        setPluginPanelScope(props.api.id, conversationId, shared ? 'session' : 'global');
      return;
    }
    if (!pinnableTab) return;
    togglePinnedTab(pinnableTab);
    if (!shared) fillPinnedEverywhere(pinnableTab);
  };
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
  const closeTabs = (kind: Exclude<TabCloseKind, 'saved'>) => {
    const list = tabNode.current ? overflowTabList(tabNode.current) : null;
    const rows = list ? snapshotOverflowRows(list) : null;
    const closed = closeGroupTabs(props.api, kind);
    if (!list || !rows) return;
    removeOverflowRows(
      list,
      closed.flatMap((id) => {
        const row = rows.get(id);
        return row ? [row] : [];
      })
    );
  };
  const pinIndicator =
    pinned && pinnableTab && !liveGlobal ? (
      // 常显 pin 指示器留在 flex 流里贴右缘：参与 tab 固有宽度，无 padding 预留；
      // 非交互，hover/聚焦时淡出，让位给 overlay 里真正可点的 Unpin，避免重影
      <span
        aria-hidden
        data-pinned-indicator
        className="inline-flex shrink-0 p-0.5 text-primary transition-opacity duration-100 group-hover/tab:opacity-0 group-has-[:focus-visible]/tab:opacity-0"
      >
        <Pin className="h-3 w-3" />
      </span>
    ) : undefined;
  const pinHoverButton =
    pinnableTab && !liveGlobal ? (
      <button
        type="button"
        aria-label={pinned ? t('Unpin default tab') : t('Pin as default tab')}
        aria-pressed={pinned}
        title={pinned ? t('Unpin default tab') : t('Pin as default tab')}
        className={cn(
          'relative shrink-0 rounded p-0.5 opacity-0 transition-opacity duration-100 hover:text-foreground group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-has-[:focus-visible]/tab:pointer-events-auto group-has-[:focus-visible]/tab:opacity-100',
          pinned ? 'text-primary' : 'text-muted-foreground'
        )}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          togglePinnedTab(pinnableTab);
        }}
      >
        <Pin className="h-3 w-3" />
      </button>
    ) : undefined;
  const tab = (
    <SidePanelTabShell
      panelId={props.api.id}
      active={active}
      pinned={pinned}
      tabRef={(node) => {
        tabNode.current = node;
      }}
      icon={
        props.api.id === 'changes' ? (
          <GitCompare className="h-3 w-3 shrink-0" />
        ) : props.api.id === 'files' ? (
          <FolderOpen className="h-3 w-3 shrink-0" />
        ) : props.api.id.startsWith('btw:') ? (
          <MessageCircle className="h-3 w-3 shrink-0" />
        ) : props.api.id === 'workflow' ? (
          <Workflow className="h-3 w-3 shrink-0" />
        ) : props.api.id === 'secretary' ? (
          <LayoutGrid className="h-3 w-3 shrink-0" />
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
        )
      }
      title={<SideTabTitle title={title} global={pluginPanel && shared} />}
      pinIndicator={pinIndicator}
      pinHoverButton={pinHoverButton}
      closeButton={
        <button
          type="button"
          className="relative shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity duration-100 hover:text-destructive group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-has-[:focus-visible]/tab:pointer-events-auto group-has-[:focus-visible]/tab:opacity-100"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const list = overflowTabList(e.currentTarget);
            const row = list ? snapshotOverflowRows(list).get(props.api.id) : undefined;
            props.api.close();
            if (list && row) removeOverflowRows(list, [row]);
          }}
        >
          <X className="h-3 w-3" />
        </button>
      }
    />
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger render={tab as ReactElement<Record<string, unknown>>} />
      <ContextMenuPopup className="min-w-40">
        <ContextMenuItem onClick={() => closeTabs('self')}>{t('Close')}</ContextMenuItem>
        <ContextMenuItem onClick={() => closeTabs('others')}>{t('Close others')}</ContextMenuItem>
        <ContextMenuItem onClick={() => closeTabs('right')}>
          {t('Close tabs to the right')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => closeTabs('all')}>{t('Close all')}</ContextMenuItem>
        {shareable ? (
          <>
            <ContextMenuSeparator />
            <ShowEverywhereItem checked={shared} onClick={toggleShared} />
          </>
        ) : null}
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
  onNewSecretary,
  secretaryLabel,
  onNewPluginView,
  secretaryPluginIds,
  compact,
  promptAt,
  onOpenChange,
}: {
  /** 缺省 = 该会话不提供这个入口（秘书会话没有终端、文件、改动） */
  onNewTerminal?: () => void;
  onNewChanges?: () => void;
  onNewFiles?: () => void;
  onNewBrowser: () => void;
  onNewBtw?: () => void;
  onNewWorkflow?: () => void;
  onNewSecretary?: () => void;
  secretaryLabel?: string;
  onNewPluginView?: (view: PluginViewRef) => void;
  /** 秘书会话传入：只列勾选了的插件页面 */
  secretaryPluginIds?: readonly string[] | null;
  compact?: boolean;
  /** 无 tab 展开的一次性信号时间戳；与 store 里一致时菜单初次即弹出 */
  promptAt?: number | null;
  /** 菜单开合回报给外层（顶栏收纳按钮组据此保持展开） */
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const allPluginViews = usePluginViews();
  const pluginViews =
    secretaryPluginIds === undefined
      ? allPluginViews
      : secretaryPluginViews(allPluginViews, secretaryPluginIds ?? undefined);
  // auto-pop 不得撞进展开动画：菜单挂载首帧 floating-ui 就以当时的锚点几何
  // 定下位置与 --available-height，而动画中的宽度/垂直布局都还没到位。
  // 实测一旦初始几何是动画中途值，位置就停留在那里不再修正（底部和右侧
  // 都被窗口裁掉、点击落空），resize 才触发重算。等动画结束再弹，
  // 与手动点 + 的测量条件一致——那条路径从不裁。
  const layoutAnimating = useLayoutAnimationStore((s) => s.active);
  // 每次提交后核对触发按钮是否仍在 document 上（脱离文档不会触发 React 重渲染，只能主动查）；
  // layout effect 里 setState 在绘制前同步重渲染，残留实例来不及露出弹层
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchorLive, setAnchorLive] = useState(false);
  useLayoutEffect(() => {
    const live = triggerRef.current?.isConnected ?? false;
    setAnchorLive((prev) => (prev === live ? prev : live));
  });
  // 一次性弹出：信号在就受控撑开；用户点类型/点别处/Esc 关闭时清掉信号，此后回到用户点 + 的非受控用法
  const prompted = newTabAutoPopOpen({ promptAt, layoutAnimating, anchorLive });
  return (
    <Menu
      key={prompted ? `prompt-${promptAt}` : 'idle'}
      defaultOpen={prompted}
      onOpenChange={(next) => {
        onOpenChange?.(next);
        if (!next) useSidePanelStore.getState().clearNewTabMenuPrompt();
      }}
    >
      <MenuTrigger
        ref={triggerRef}
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
        {onNewTerminal ? (
          <MenuItem onClick={onNewTerminal}>
            <SquareTerminal className="h-4 w-4" />
            {t('Terminal')}
          </MenuItem>
        ) : null}
        {onNewChanges ? (
          <MenuItem onClick={onNewChanges}>
            <GitCompare className="h-4 w-4" />
            {t('Changes')}
          </MenuItem>
        ) : null}
        {onNewFiles ? (
          <MenuItem onClick={onNewFiles}>
            <FolderOpen className="h-4 w-4" />
            {t('Files')}
          </MenuItem>
        ) : null}
        <MenuItem onClick={onNewBrowser}>
          <Globe className="h-4 w-4" />
          {t('Browser')}
        </MenuItem>
        {onNewBtw ? (
          <MenuItem onClick={onNewBtw}>
            <MessageCircle className="h-4 w-4" />
            {t('Btw')}
          </MenuItem>
        ) : null}
        {onNewWorkflow ? (
          <MenuItem onClick={onNewWorkflow}>
            <Workflow className="h-4 w-4" />
            {t('Workflow')}
          </MenuItem>
        ) : null}
        {onNewSecretary ? (
          <MenuItem data-enso="secretary-panel-open" onClick={onNewSecretary}>
            <LayoutGrid className="h-4 w-4" />
            {secretaryLabel ?? t('Secretary')}
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
  const secretary = useSecretaryConversation(projectId);
  const secretaryPluginIds = useSecretaryPluginIds();
  const secretaryName = useSecretaryName();
  const isMobile = useIsMobile();
  const titleRow = useContext(TitleRowContext);
  const topRight = useIsTopRightGroup(containerApi, group);
  const toggleOpen = useSidePanelStore((s) => s.toggleOpen);
  const windows = useWindowChromeKind() === 'windows';
  // auto-pop 锚定在顶部 compact +（不是居中水印按钮）：
  // 用户展开空面板想直接点类型，菜单贴着常驻的 + 出现一眼就能找；
  // 顶栏几何在展开动画里几乎不动，也进一步远离当初测量撞上中途几何的场景。
  const headerNewTabMenuPromptAt = useSidePanelStore((s) =>
    headerNewTabPromptAt({
      prompt: s.newTabMenuPrompt,
      conversationId,
      inGroup: group !== undefined,
      secretary,
    })
  );
  // 深链或手机按钮要求定位某张卡时把秘书面板叫出来；同一个请求只处理一次
  const focusProposal = useSecretaryStore((s) => s.focusProposal);
  const handledFocus = useRef(0);
  useEffect(() => {
    if (!focusProposal || !secretary || focusProposal.at === handledFocus.current) return;
    handledFocus.current = focusProposal.at;
    addSecretaryPanel(containerApi, conversationId, projectId, secretaryName);
  }, [focusProposal, secretary, containerApi, conversationId, projectId, secretaryName]);
  // 顶栏右端三个按钮（+ / 全屏 / 收起）平时收纳成一个「…」省出 tab 条空间：
  // hover / 键盘聚焦时 + 和全屏从左侧展开，「…」变回收起图标；直接点「…」就是收起。
  // 只在三个按钮齐全的位置（顶栏行 + 右上角组）收纳，其余位置照旧平铺；触屏不收纳。
  const collapsible = titleRow && topRight;
  const [menuOpen, setMenuOpen] = useState(false);
  const pinned = headerActionsPinned({ menuOpen, promptAt: headerNewTabMenuPromptAt });
  return (
    <div className="flex h-full items-center gap-0.5">
      <div
        data-side-actions
        data-expanded={collapsible && pinned ? '' : undefined}
        className={cn(
          'flex h-full items-center gap-0.5',
          // 整组豁免拖窗：顶栏行是 drag 区，按钮间缝隙若可拖，Electron 会吞掉鼠标事件、hover 断档
          collapsible && 'group/side-actions [-webkit-app-region:no-drag]'
        )}
      >
        <div className={cn('flex items-center gap-0.5', collapsible && SIDE_ACTIONS_EXTRA_CLASS)}>
          <NewTabMenu
            compact
            promptAt={headerNewTabMenuPromptAt}
            onOpenChange={setMenuOpen}
            onNewTerminal={
              secretary
                ? undefined
                : () => {
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
                  }
            }
            onNewChanges={
              secretary
                ? undefined
                : () => addChangesPanel(containerApi, conversationId, projectId, t('Changes'))
            }
            onNewFiles={
              secretary
                ? undefined
                : () => addFilesPanel(containerApi, conversationId, projectId, t('Files'))
            }
            onNewBrowser={() =>
              addBrowserPanel(containerApi, conversationId, projectId, t('Browser'))
            }
            onNewBtw={
              secretary
                ? undefined
                : () => {
                    if (group) {
                      const count = containerApi.panels.filter((panel) =>
                        panel.id.startsWith('btw:')
                      ).length;
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
                  }
            }
            onNewWorkflow={
              workflowAvailable && !secretary
                ? () => addWorkflowPanel(containerApi, conversationId, projectId, t('Workflow'))
                : undefined
            }
            onNewSecretary={
              secretary
                ? () => addSecretaryPanel(containerApi, conversationId, projectId, secretaryName)
                : undefined
            }
            secretaryLabel={secretaryName}
            onNewPluginView={(view) =>
              addPluginViewPanel(containerApi, conversationId, projectId, view, group)
            }
            secretaryPluginIds={secretary ? secretaryPluginIds : undefined}
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
            {fullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        {collapsible && <SidePanelCollapseButton onClick={toggleOpen} />}
        {/* 窄屏面板全屏盖住工作区：就近给关闭，不必回顶栏找开关 */}
        {isMobile && <SidePanelCloseButton onClick={toggleOpen} />}
      </div>
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
  const secretary = useSecretaryConversation(projectId);
  const secretaryPluginIds = useSecretaryPluginIds();
  const secretaryName = useSecretaryName();
  // dock 隐藏（切会话/收起面板）时整个水印不渲染：
  // 菜单弹层走 Portal 挂在 body 上，display:none 的容器关不住它——
  // 锚点 rect 归零后弹层漂到视口左上角、高度也不再受裁剪限制，
  // 再开第二个菜单就是用户看到的「一大一小双 popover」。卸载即关。
  const isActiveConversation = useSessionsStore((s) => s.activeId === conversationId);
  const panelShown = useSidePanelShown(conversationId);
  if (!isActiveConversation || !panelShown) return null;
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
          onNewTerminal={
            secretary
              ? undefined
              : () => addTerminalPanel(props.containerApi, conversationId, projectId, t('Terminal'))
          }
          onNewChanges={
            secretary
              ? undefined
              : () => addChangesPanel(props.containerApi, conversationId, projectId, t('Changes'))
          }
          onNewFiles={
            secretary
              ? undefined
              : () => addFilesPanel(props.containerApi, conversationId, projectId, t('Files'))
          }
          onNewBrowser={() =>
            addBrowserPanel(props.containerApi, conversationId, projectId, t('Browser'))
          }
          onNewBtw={
            secretary
              ? undefined
              : () => addBtwPanel(props.containerApi, conversationId, projectId, t('Btw'))
          }
          onNewWorkflow={
            workflowAvailable && !secretary
              ? () => addWorkflowPanel(props.containerApi, conversationId, projectId, t('Workflow'))
              : undefined
          }
          onNewSecretary={
            secretary
              ? () =>
                  addSecretaryPanel(props.containerApi, conversationId, projectId, secretaryName)
              : undefined
          }
          secretaryLabel={secretaryName}
          onNewPluginView={(view) =>
            addPluginViewPanel(props.containerApi, conversationId, projectId, view)
          }
          secretaryPluginIds={secretary ? secretaryPluginIds : undefined}
        />
      </div>
    </div>
  );
}

/** 每个分组 tab 条右侧的 + 按钮:新 tab 落在该组 */
function GroupRightActions(props: IDockviewHeaderActionsProps) {
  return <SidePanelHeaderActions containerApi={props.containerApi} group={props.group} />;
}

/** 每种面板各包一层错误边界：一块出错只在那一块显示原因，不白屏也不拖垮窗口 */
function guardPanel<P extends object>(name: string, Panel: (props: P) => ReactNode) {
  return function GuardedPanel(props: P) {
    return (
      <PanelErrorBoundary name={name}>
        <Panel {...props} />
      </PanelErrorBoundary>
    );
  };
}

const DOCK_COMPONENTS = {
  terminal: guardPanel('terminal', TerminalPanel),
  changes: guardPanel('changes', ChangesPanel),
  files: guardPanel('files', FilesPanel),
  browser: guardPanel('browser', BrowserPanel),
  btw: guardPanel('btw', BtwPanel),
  workflow: guardPanel('workflow', WorkflowPanel),
  secretary: guardPanel('secretary', Secretary),
  plugin: guardPanel('plugin', PluginViewPanel),
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
  const { t } = useI18n();
  const isDark = useIsDark();
  const workflowAvailable = useWorkflowAvailable(projectId);
  const secretary = useSecretaryConversation(projectId);
  const secretaryPluginIds = useSecretaryPluginIds();
  const pluginViews = usePluginViews();
  const secretaryName = useSecretaryName();
  const [revealSecretaryConsole] = useState(createSecretaryConsoleReveal);
  const [dockApi, setDockApi] = useState<DockviewApi | null>(null);
  const dockApiRef = useRef<DockviewApi | null>(null);
  const activeConversationId = useSessionsStore((state) => state.activeId);
  const sidePanelOpen = useSidePanelShown(conversationId);
  const explicitOpen = useSidePanelStore(
    (state) => state.uiByConversation[conversationId]?.open === true
  );
  const pinnedTabs = useSidePanelStore((state) => state.pinnedTabs);
  const globalTabs = useSidePanelStore((state) => state.globalTabs);
  const liveGlobalTabs = useSidePanelStore((state) => state.liveGlobalTabs);
  const scopeOverrides = useSidePanelStore((state) => state.globalScopeOverrides);
  const viewsReady = usePluginViewsReady();
  const globalFullSynced = useRef(false);
  // 卸载（Bot 模式、删会话）前先解绑：dockview 自己清面板时不能当成用户关了全局标签。
  // StrictMode 会卸了再装一次，装回时重新绑上
  useLayoutEffect(() => {
    if (dockApiRef.current) bindSidePanelDock(conversationId, dockApiRef.current);
    return () => {
      if (dockApiRef.current) unbindSidePanelDock(conversationId, dockApiRef.current);
    };
  }, [conversationId]);
  // 关掉工具时收起已开的工作流 tab；恢复布局带回来的也一并收掉
  useEffect(() => {
    if (!workflowAvailable) dockApi?.getPanel('workflow')?.api.close();
  }, [dockApi, workflowAvailable]);
  // 秘书设置里取消勾选插件：收起该插件已开的页面；恢复布局带回来的也一并收掉
  useEffect(() => {
    if (!dockApi || !secretary) return;
    const ids = dockApi.panels.map((panel) => panel.id);
    const exempt = new Set([...globalTabs, ...liveGlobalTabs]);
    for (const id of secretaryPluginPanelsToClose(ids, secretaryPluginIds, exempt)) {
      dockApi.getPanel(id)?.api.close();
    }
  }, [dockApi, secretary, secretaryPluginIds, globalTabs, liveGlobalTabs]);

  // 全局标签：挂载后第一次补齐缺的、删掉别处已关的；之后跟着 globalTabs / 作用域变化补齐
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同步读 store 最新值，这些依赖只用来触发重算
  useEffect(() => {
    if (!dockApi || !viewsReady) return;
    syncDockGlobalTabs(conversationId, dockApi, !globalFullSynced.current);
    globalFullSynced.current = true;
  }, [conversationId, dockApi, explicitOpen, globalTabs, pluginViews, scopeOverrides, viewsReady]);

  const addPinned = (
    api: DockviewApi,
    tabs: readonly PinnableSidePanelTab[]
  ): string | undefined => {
    const plans = planPinnedPanels({
      pinnedTabs: tabs,
      openPanelIds: api.panels.map((panel) => panel.id),
      secretary,
      workflowAvailable,
      pluginViews,
      secretaryPluginIds,
    });
    let firstAddedId: string | undefined;
    for (const plan of plans) {
      if (plan.kind === 'terminal') {
        const id = crypto.randomUUID();
        api.addPanel({
          id,
          component: 'terminal',
          title: t('Terminal'),
          params: { conversationId, projectId },
        });
        firstAddedId ??= id;
      } else if (plan.kind === 'changes') {
        addChangesPanel(api, conversationId, projectId, t('Changes'));
        firstAddedId ??= 'changes';
      } else if (plan.kind === 'files') {
        addFilesPanel(api, conversationId, projectId, t('Files'));
        firstAddedId ??= 'files';
      } else if (plan.kind === 'browser') {
        const id = `browser:${crypto.randomUUID()}`;
        addBrowserPanel(api, conversationId, projectId, t('Browser'), id);
        firstAddedId ??= id;
      } else if (plan.kind === 'btw') {
        const id = `btw:${crypto.randomUUID()}`;
        addBtwPanel(api, conversationId, projectId, t('Btw'), id);
        firstAddedId ??= id;
      } else if (plan.kind === 'workflow') {
        addWorkflowPanel(api, conversationId, projectId, t('Workflow'));
        firstAddedId ??= 'workflow';
      } else {
        const view = pluginViews.find(
          (entry) => entry.pluginId === plan.pluginId && entry.id === plan.viewId
        );
        if (!view) continue;
        const id = `plugin:${plan.pluginId}:${plan.viewId}`;
        addPluginViewPanel(api, conversationId, projectId, view);
        firstAddedId ??= id;
      }
    }
    return firstAddedId;
  };
  const addPinnedRef = useRef(addPinned);
  addPinnedRef.current = addPinned;

  // 右键「在所有会话中显示」固定内置标签：已挂载的会话各补一份，不抢各自选中的标签
  useEffect(() => {
    const fill = (tab: PinnableSidePanelTab) => {
      const api = dockApiRef.current;
      if (!api) return;
      const previous = api.activePanel;
      if (addPinnedRef.current(api, [tab]) && previous) previous.api.setActive();
    };
    pinnedFillListeners.add(fill);
    return () => {
      pinnedFillListeners.delete(fill);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 计划经 addPinnedRef 读最新值，这些依赖只用来触发重算
  useEffect(() => {
    if (!dockApi || !sidePanelOpen || activeConversationId !== conversationId) return;
    const wasEmpty = dockApi.panels.length === 0;
    const firstAddedId = addPinnedRef.current(dockApi, pinnedTabs);
    if (wasEmpty && firstAddedId) dockApi.getPanel(firstAddedId)?.focus();
  }, [
    activeConversationId,
    conversationId,
    dockApi,
    pluginViews,
    pinnedTabs,
    projectId,
    secretary,
    secretaryPluginIds,
    sidePanelOpen,
    t,
    workflowAvailable,
  ]);

  // 秘书会话每次打开侧栏都保证有秘书面板并切过去；放在固定标签之后，最后选中的是它
  useEffect(() => {
    const reveal = revealSecretaryConsole({
      secretary,
      open: sidePanelOpen,
      active: activeConversationId === conversationId,
      ready: dockApi !== null,
    });
    if (reveal && dockApi) addSecretaryPanel(dockApi, conversationId, projectId, secretaryName);
  }, [
    activeConversationId,
    conversationId,
    dockApi,
    projectId,
    revealSecretaryConsole,
    secretary,
    secretaryName,
    sidePanelOpen,
  ]);

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
    watchSidePanelAutoCollapse(conversationId, event.api);
    watchGlobalTabs(conversationId, event.api);
    event.api.onDidLayoutChange(() => {
      const json = event.api.toJSON();
      if (ignoreEmptySave && Object.keys(json.panels ?? {}).length === 0) return;
      ignoreEmptySave = false;
      useSidePanelStore.getState().saveLayout(conversationId, json);
    });
    // 只有用户关 tab 才回收;dock 本身不随切会话卸载
    event.api.onDidRemovePanel((panel) => {
      if (
        panel.id === 'changes' ||
        panel.id === 'files' ||
        panel.id === 'secretary' ||
        panel.id.startsWith('plugin:')
      )
        return;
      if (panel.id === 'browser' || panel.id.startsWith('browser:')) {
        // 远程渲染的是宿主浏览器的只读提示，没有可关闭的宿主标签
        if (!isRemoteClient()) void window.electronAPI.browser.closeTab(panel.id);
        return;
      }
      if (panel.id.startsWith('btw:')) {
        void useSessionsStore.getState().disposeBtwConversation(panel.id.slice(4));
        return;
      }
      releaseTerminal(panel.id);
      void window.electronAPI.terminal.dispose(panel.id);
    });
    dockApiRef.current = event.api;
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
  const open = useSidePanelShown(activeIdForUi);
  // 窄屏没有并排空间：打开即全屏盖住聊天区
  const isMobile = useIsMobile();
  const settingsOpen = useSettingsOpen();
  const storeFullscreen = useSidePanelStore((s) => s.fullscreen);
  const fullscreen = sidePanelCoversMain({ open, fullscreen: storeFullscreen, isMobile });
  useEffect(() => bindLiveGlobalTabs(), []);
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
    restoreHostBrowserTabs();
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
  // 动画中途卸载收不到 complete，不复位会让聊天区永远不跟随
  useEffect(() => () => setLayoutAnimating(false), []);
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
        onAnimationStart={() => setLayoutAnimating(true)}
        onAnimationComplete={() => {
          setLayoutAnimating(false);
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
            ? cn(
                'no-drag',
                liftsIntoTitleRow({ titleRow, isMobile, settingsOpen }) && '-mt-[44px]',
                cover ? 'rounded-b-[10px]' : 'rounded-br-[10px]'
              )
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
          {/* 全局插件层和各会话 dock 同级常驻：没有当前会话时也不卸载，只藏起来 */}
          <div className="relative min-h-0 flex-1">
            <TitleRowContext.Provider value={inTitleRow}>
              {visibleIds.map((id) => (
                <MountedConversationDock key={id} conversationId={id} hidden={id !== activeId} />
              ))}
            </TitleRowContext.Provider>
            <GlobalPluginLayer />
            {visibleIds.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {t('Select a conversation to use the side panel.')}
              </div>
            ) : null}
          </div>
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
    const clip = holesClipPath(local) ?? '';
    el.style.clipPath = clip;
    const panel = el.closest<HTMLElement>('[data-enso="side-panel"]');
    if (panel) {
      if (clip) {
        panel.style.setProperty('--enso-side-panel-holes-clip', clip);
      } else {
        panel.style.removeProperty('--enso-side-panel-holes-clip');
      }
    }
    return () => {
      panel?.style.removeProperty('--enso-side-panel-holes-clip');
    };
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
