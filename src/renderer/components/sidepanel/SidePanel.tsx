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
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import { springStandard } from '@/lib/motion';
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

/** 后置兄弟:卸载顺序为后子先清,保证在 DockviewReact dispose 之前取消布局订阅 */
function DockUnmountGuard({ onUnmount }: { onUnmount: () => void }) {
  const fn = useRef(onUnmount);
  fn.current = onUnmount;
  useEffect(() => () => fn.current(), []);
  return null;
}

function ConversationDock({ conversationId, cwd }: { conversationId: string; cwd?: string }) {
  const isDark = useIsDark();
  const aliveRef = useRef(true);
  const subRef = useRef<{ dispose: () => void } | null>(null);

  const onReady = (event: DockviewReadyEvent) => {
    aliveRef.current = true;
    // dev-only:e2e/调试可经 CDP 直达 dockview api
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__dockviewApi = event.api;
    }
    const saved = useSidePanelStore.getState().layouts[conversationId];
    if (saved) {
      try {
        event.api.fromJSON(saved);
      } catch {
        // 布局数据与当前版本不兼容:放弃恢复,从空态开始
      }
    }
    subRef.current = event.api.onDidLayoutChange(() => {
      // 切会话卸载会 dispose 全部 panel:绝不能当成关 tab 去杀 pty/快照
      if (!aliveRef.current) return;
      useSidePanelStore.getState().saveLayout(conversationId, event.api.toJSON());
    });
  };

  return (
    <PanelContext.Provider value={{ cwd }}>
      <div className="h-full">
        <DockviewReact
          components={DOCK_COMPONENTS}
          watermarkComponent={Watermark}
          rightHeaderActionsComponent={GroupRightActions}
          theme={isDark ? themeDark : themeLight}
          onReady={onReady}
        />
        <DockUnmountGuard
          onUnmount={() => {
            aliveRef.current = false;
            subRef.current?.dispose();
            subRef.current = null;
          }}
        />
      </div>
    </PanelContext.Provider>
  );
}

export function SidePanel({ width, resizing = false }: { width: number; resizing?: boolean }) {
  const { t } = useI18n();
  const open = useSidePanelStore((s) => s.open);
  const toggleOpen = useSidePanelStore((s) => s.toggleOpen);
  const conversation = useSessionsStore((s) => (s.activeId ? s.conversations[s.activeId] : null));
  const projects = useSettingsStore((s) => s.projects);

  // 终端 cwd:worktree 目录优先,否则项目目录
  const cwd =
    conversation?.worktree?.path ?? projects.find((p) => p.id === conversation?.projectId)?.path;

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
        {conversation ? (
          <div className="min-h-0 flex-1">
            <ConversationDock key={conversation.id} conversationId={conversation.id} cwd={cwd} />
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
