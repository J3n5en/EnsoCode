import type { SettingsDeepLink } from '@shared/settingsDeepLink';
import {
  ArrowLeft,
  BarChart3,
  Bot,
  BotMessageSquare,
  Brain,
  ChevronLeft,
  ChevronRight,
  ContactRound,
  FileText,
  FlaskConical,
  Gauge,
  Keyboard,
  Layers,
  LayoutTemplate,
  MessageSquareText,
  MessagesSquare,
  Palette,
  Plug,
  Puzzle,
  ScrollText,
  Server,
  Settings,
  Shield,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Terminal,
  Timer,
  Workflow,
  Wrench,
} from 'lucide-react';
import * as React from 'react';
import { ResizeHandle } from '@/components/chat/ResizeHandle';
import { useSettingsCatalog } from '@/hooks/useSettingsCatalog';
import { useIsMobile } from '@/hooks/useViewport';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { AgentTypesSettings } from './AgentTypesSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { BotSettings } from './BotSettings';
import { BotTemplatesSettings } from './BotTemplatesSettings';
import { BuiltinToolsSettings } from './BuiltinToolsSettings';
import { ContactsSettings } from './ContactsSettings';
import { ConversationSettings } from './ConversationSettings';
import type { SettingsCategory } from './constants';
import { DevicesSettings } from './DevicesSettings';
import { ExperimentalSettings } from './ExperimentalSettings';
import { GeneralSettings } from './GeneralSettings';
import { InstructionsSettings } from './InstructionsSettings';
import { KeybindingsSettings } from './KeybindingsSettings';
import { SettingsButton, SettingsSearch } from './kit';
import { LogsSettings } from './LogsSettings';
import { McpSettings } from './McpSettings';
import { MemoryKnowledge } from './MemoryKnowledge';
import { MemoryLibrary } from './MemoryLibrary';
import { MemorySettings } from './MemorySettings';
import { EnsoPluginsSettings } from './PluginsSettings';
import { PresetsSettings } from './PresetsSettings';
import { PrivacySettings } from './PrivacySettings';
import { ProvidersSettings } from './ProvidersSettings';
import { ResourcesSettings } from './ResourcesSettings';
import { RuntimeSettings } from './RuntimeSettings';
import { SecretarySettings } from './SecretarySettings';
import { SkillsSettings } from './SkillsSettings';
import { SshSettings } from './SshSettings';
import {
  groupCategories,
  resolveActiveCategory,
  SETTINGS_CATEGORY_LABELS,
  searchCategories,
  settingsEntryPath,
  visibleCategories,
} from './settingsCategories';
import { TerminalSettings } from './TerminalSettings';
import { UsageSettings } from './UsageSettings';
import { WorkflowsSettings } from './WorkflowsSettings';

/** 行可能要等父项展开或异步数据才出现：短时间内反复找，找到再滚过去并闪一下 */
function flashSettingsRow(rowId: string, cancelRestore: () => void): () => void {
  let attempts = 0;
  let timer = 0;
  let follow = 0;
  let finish = 0;
  const tryFlash = () => {
    const el = document.querySelector(`[data-settings-row="${CSS.escape(rowId)}"]`);
    if (el instanceof HTMLElement) {
      // 分区异步加载时会整段重渲染，第一次拿到的元素会被换掉，所以每次重新找
      let left = 3;
      const center = () => {
        const row = document.querySelector(`[data-settings-row="${CSS.escape(rowId)}"]`);
        if (row instanceof HTMLElement) {
          row.scrollIntoView({ block: 'center', behavior: 'instant' });
          row.dataset.settingsFlash = 'true';
        }
        if (--left <= 0) window.clearInterval(follow);
      };
      cancelRestore();
      center();
      follow = window.setInterval(center, 400);
      finish = window.setTimeout(stop, 1600);
      return;
    }
    if (attempts++ < 12) timer = window.setTimeout(tryFlash, 50);
  };
  const stop = () => {
    window.clearInterval(follow);
    const row = document.querySelector(`[data-settings-row="${CSS.escape(rowId)}"]`);
    if (row instanceof HTMLElement) delete row.dataset.settingsFlash;
  };
  tryFlash();
  return () => {
    window.clearTimeout(timer);
    window.clearTimeout(finish);
    stop();
  };
}

const USER_SCROLL_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/** 分区内容可能异步变高：保存的位置以最终布局为准，窗口期内每次变高都重新设回去（否则滚动锚定会把它推偏）；用户一动或 2s 后放弃 */
function restoreScrollTop(el: HTMLElement, top: number, onDone: () => void): () => void {
  el.scrollTop = top;
  if (top === 0 || typeof ResizeObserver === 'undefined') {
    onDone();
    return () => {};
  }
  const stop = () => {
    observer.disconnect();
    window.clearTimeout(timer);
    for (const type of USER_SCROLL_INPUT) el.removeEventListener(type, stop);
    onDone();
  };
  const observer = new ResizeObserver(() => {
    el.scrollTop = top;
  });
  for (const child of el.children) observer.observe(child);
  for (const type of USER_SCROLL_INPUT) el.addEventListener(type, stop, { passive: true });
  const timer = window.setTimeout(stop, 2000);
  return stop;
}

/** 返回按钮、侧栏宽度、窄屏两级由主窗口的设置路由掌管 */
export interface EmbeddedSettings {
  initialCategory: SettingsCategory;
  onCategoryChange: (category: SettingsCategory) => void;
  mobileDetail: boolean;
  onMobileDetailChange: (detail: boolean) => void;
  onBack: () => void;
  navWidth: number;
  /** 拖侧栏手柄：位移交回外层，和工作区侧栏共用同一个宽度 */
  onNavResize?: (deltaX: number) => void;
  footer?: React.ReactNode;
}

export function SettingsContent({
  link,
  linkSeq,
  embedded,
}: {
  link: SettingsDeepLink | null;
  linkSeq: number;
  embedded: EmbeddedSettings;
}) {
  const { t } = useI18n();
  const [activeCategory, setActiveCategory] = React.useState<SettingsCategory>(
    () => link?.category ?? embedded.initialCategory
  );
  const [flashRowId, setFlashRowId] = React.useState<string | null>(null);
  const [pluginInstallUrl, setPluginInstallUrl] = React.useState<string | null>(null);
  const [focusPluginId, setFocusPluginId] = React.useState<string | null>(null);
  const [marketQuery, setMarketQuery] = React.useState<string | null>(null);
  // 提炼写入记忆后让记忆库重新拉数据（两个组件各自持有列表）
  const [memoryRevision, setMemoryRevision] = React.useState(0);
  // 窄屏下分类列表与内容逐级进入
  const isMobile = useIsMobile();
  const mobileList = !embedded.mobileDetail;
  const setMobileList = (list: boolean) => embedded.onMobileDetailChange(!list);
  const [settingsQuery, setSettingsQuery] = React.useState('');
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'f'
      ) {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest('.cm-editor, .monaco-editor, [data-code-editor], [contenteditable="true"]')
        ) {
          return;
        }
        const input = searchInputRef.current;
        if (!input) return;
        event.preventDefault();
        input.focus();
        input.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const [sshConnections, setSshConnections] = React.useState<Array<{ id: string; name: string }>>(
    []
  );
  const openCategory = (category: SettingsCategory) => {
    setActiveCategory(category);
    setMobileList(false);
  };
  const disabledBuiltinTools = useSettingsStore((state) => state.disabledBuiltinTools);
  const botModeEnabled = useSettingsStore((state) => state.botModeEnabled);
  const secretaryEnabled = useSettingsStore((state) => state.secretaryEnabled);
  // 水合前 botModeEnabled 恒为 false：此时不据此把指向 Bot 页的深链改落到实验页
  const hydrated = React.useSyncExternalStore(
    (onChange) => useSettingsStore.persist?.onFinishHydration?.(onChange) ?? (() => {}),
    () => useSettingsStore.persist?.hasHydrated?.() ?? true
  );

  // linkSeq 变了就重新定位（同一链接重复打开也要再闪一次）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 按 linkSeq 触发
  React.useEffect(() => {
    if (!link) return;
    setActiveCategory(link.category);
    setFlashRowId(link.rowId);
    if (link.pluginInstallUrl) setPluginInstallUrl(link.pluginInstallUrl);
    setFocusPluginId(link.pluginId ?? null);
    setMarketQuery(link.marketQuery ?? null);
  }, [linkSeq]);

  const onCategoryChange = embedded.onCategoryChange;
  React.useEffect(() => {
    onCategoryChange(activeCategory);
  }, [activeCategory, onCategoryChange]);

  React.useEffect(() => {
    let active = true;
    void window.electronAPI.sshConnections
      .list()
      .then((list) => {
        if (!active) return;
        setSshConnections(list.map((item) => ({ id: item.id, name: item.name })));
      })
      .catch(() => {
        if (active) setSshConnections([]);
      });
    return () => {
      active = false;
    };
  }, []);
  const settingsCatalog = useSettingsCatalog(sshConnections);

  const showList = !isMobile || mobileList;
  const showContent = !isMobile || !mobileList;

  // 内容区只有一个滚动容器：按分区记住各自的 scrollTop，换分区（或窄屏重新进入内容页）时恢复，没去过的从顶部开始
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const scrollPositions = React.useRef(new Map<SettingsCategory, number>());
  const scrollKey = React.useRef<SettingsCategory | null>(null);
  const restoring = React.useRef(false);
  const scrollRestore = React.useRef<(() => void) | null>(null);
  const flashPending = React.useRef(flashRowId);
  flashPending.current = flashRowId;
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!showContent || !el) return;
    scrollKey.current = activeCategory;
    // 深链/搜索命中要定位到行（本 effect 声明在 flash 之前，先执行），交给 flashSettingsRow，不用保存的位置覆盖
    if (flashPending.current) {
      el.scrollTop = 0;
      restoring.current = false;
      return;
    }
    restoring.current = true;
    const stop = restoreScrollTop(el, scrollPositions.current.get(activeCategory) ?? 0, () => {
      restoring.current = false;
    });
    scrollRestore.current = stop;
    return () => {
      scrollRestore.current = null;
      stop();
    };
  }, [activeCategory, showContent]);
  const rememberScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (restoring.current || !scrollKey.current) return;
    scrollPositions.current.set(scrollKey.current, event.currentTarget.scrollTop);
  };

  React.useLayoutEffect(() => {
    if (!flashRowId) return;
    // flashRowId 留着：被父开关藏起的行靠它临时展开，清掉会把刚定位到的行又卸掉
    return flashSettingsRow(flashRowId, () => scrollRestore.current?.());
  }, [flashRowId]);

  const allCategories: Array<{
    id: SettingsCategory;
    icon: React.ElementType;
    label: string;
    /** 子菜单：缩进挂在父分类下 */
    sub?: boolean;
  }> = [
    { id: 'general', icon: Settings, label: SETTINGS_CATEGORY_LABELS.general },
    { id: 'shortcuts', icon: Keyboard, label: SETTINGS_CATEGORY_LABELS.shortcuts },
    { id: 'appearance', icon: Palette, label: SETTINGS_CATEGORY_LABELS.appearance },
    { id: 'conversation', icon: MessageSquareText, label: SETTINGS_CATEGORY_LABELS.conversation },
    { id: 'terminal', icon: SquareTerminal, label: SETTINGS_CATEGORY_LABELS.terminal },
    { id: 'runtime', icon: Timer, label: SETTINGS_CATEGORY_LABELS.runtime },
    { id: 'providers', icon: Server, label: SETTINGS_CATEGORY_LABELS.providers },
    { id: 'presets', icon: Layers, label: SETTINGS_CATEGORY_LABELS.presets },
    { id: 'agents', icon: Bot, label: SETTINGS_CATEGORY_LABELS.agents },
    { id: 'tools', icon: Wrench, label: SETTINGS_CATEGORY_LABELS.tools },
    { id: 'workflows', icon: Workflow, label: SETTINGS_CATEGORY_LABELS.workflows },
    { id: 'memory', icon: Brain, label: SETTINGS_CATEGORY_LABELS.memory },
    { id: 'privacy', icon: Shield, label: SETTINGS_CATEGORY_LABELS.privacy },
    { id: 'skills', icon: Sparkles, label: SETTINGS_CATEGORY_LABELS.skills },
    { id: 'plugins', icon: Puzzle, label: SETTINGS_CATEGORY_LABELS.plugins },
    { id: 'mcp', icon: Plug, label: SETTINGS_CATEGORY_LABELS.mcp },
    { id: 'instructions', icon: FileText, label: SETTINGS_CATEGORY_LABELS.instructions },
    { id: 'phone', icon: Smartphone, label: SETTINGS_CATEGORY_LABELS.phone },
    { id: 'ssh', icon: Terminal, label: SETTINGS_CATEGORY_LABELS.ssh },
    { id: 'usage', icon: BarChart3, label: SETTINGS_CATEGORY_LABELS.usage },
    { id: 'resources', icon: Gauge, label: SETTINGS_CATEGORY_LABELS.resources },
    { id: 'logs', icon: ScrollText, label: SETTINGS_CATEGORY_LABELS.logs },
    { id: 'experimental', icon: FlaskConical, label: SETTINGS_CATEGORY_LABELS.experimental },
    { id: 'secretary', icon: MessagesSquare, label: SETTINGS_CATEGORY_LABELS.secretary },
    { id: 'contacts', icon: ContactRound, label: SETTINGS_CATEGORY_LABELS.contacts },
    { id: 'bots', icon: BotMessageSquare, label: SETTINGS_CATEGORY_LABELS.bots, sub: true },
    {
      id: 'botTemplates',
      icon: LayoutTemplate,
      label: SETTINGS_CATEGORY_LABELS.botTemplates,
      sub: true,
    },
  ];
  const categories = visibleCategories(
    allCategories,
    disabledBuiltinTools,
    botModeEnabled,
    secretaryEnabled || !hydrated
  );
  const groupedCategories = groupCategories(
    searchCategories(categories, settingsCatalog, settingsQuery, t)
  );

  // 关掉 memory 工具时当前页会消失（deeplink 也可能指向未启用的功能），落到能重新打开它的地方
  const resolvedCategory = resolveActiveCategory(
    activeCategory,
    disabledBuiltinTools,
    botModeEnabled || !hydrated,
    secretaryEnabled || !hydrated
  );
  React.useEffect(() => {
    if (resolvedCategory !== activeCategory) setActiveCategory(resolvedCategory);
  }, [resolvedCategory, activeCategory]);

  const activeLabel = categories.find((c) => c.id === activeCategory)?.label;
  const hitButtonRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const flatHits = groupedCategories.flatMap((group) =>
    group.items.flatMap((category) => category.hits)
  );
  const focusHit = (index: number) => {
    const hit = flatHits[index];
    if (hit) hitButtonRefs.current.get(hit.id)?.focus();
  };

  return (
    <div className="flex h-full w-full">
      {/* 左侧：分类列表 */}
      {showList && (
        <nav
          data-enso="settings-nav"
          className={cn('flex min-h-0 shrink-0 flex-col', isMobile && 'w-full')}
          style={isMobile ? undefined : { width: embedded.navWidth }}
        >
          <div className={cn('flex shrink-0 items-center px-2', isMobile ? 'h-12' : 'h-9')}>
            <button
              type="button"
              data-enso="settings-back"
              onClick={embedded.onBack}
              className={cn(
                'flex items-center gap-1.5 rounded-md pr-2 text-sm font-medium text-foreground transition-colors hover:bg-accent/50',
                isMobile ? 'h-11 pl-1.5' : 'h-8 pl-1'
              )}
              title={t('Back to workspace')}
              aria-label={t('Back to workspace')}
            >
              <ArrowLeft className="h-4 w-4 text-muted-foreground" />
              {t('Settings')}
            </button>
            {!isMobile && (
              <span className="ml-auto pr-1 text-[11px] text-muted-foreground">Esc</span>
            )}
          </div>
          <div className="sticky top-0 z-10 px-2 pt-2">
            <SettingsSearch
              inputRef={searchInputRef}
              value={settingsQuery}
              onValueChange={setSettingsQuery}
              placeholder={t('Search settings')}
              onArrowDown={() => focusHit(0)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {settingsQuery.trim() && groupedCategories.length === 0 ? (
              <div className="flex flex-col items-start gap-2 px-3 py-2">
                <span className="text-xs text-muted-foreground">{t('No results')}</span>
                <SettingsButton variant="ghost" size="xs" onClick={() => setSettingsQuery('')}>
                  {t('Clear search')}
                </SettingsButton>
              </div>
            ) : (
              groupedCategories.map((group, index) => (
                <div key={group.id} className={cn(index > 0 && 'mt-4')}>
                  <div className="px-2 pb-1.5 text-xs font-semibold text-foreground/55">
                    {t(group.label)}
                  </div>
                  <div className="space-y-0.5">
                    {group.items.map((category) => (
                      <div key={category.id}>
                        <button
                          type="button"
                          onClick={() => openCategory(category.id)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-3 text-sm transition-colors',
                            isMobile ? 'py-3' : 'py-1.5',
                            category.sub && 'pl-8',
                            activeCategory === category.id && !isMobile
                              ? 'bg-background text-foreground shadow-xs'
                              : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
                          )}
                        >
                          <category.icon className="h-4 w-4" />
                          {t(category.label)}
                          {isMobile && <ChevronRight className="ml-auto h-4 w-4 opacity-60" />}
                        </button>
                        {category.hits.map((hit) => (
                          <button
                            type="button"
                            key={hit.id}
                            ref={(node) => {
                              if (node) hitButtonRefs.current.set(hit.id, node);
                              else hitButtonRefs.current.delete(hit.id);
                            }}
                            onKeyDown={(event) => {
                              const index = flatHits.findIndex((item) => item.id === hit.id);
                              if (event.key === 'ArrowDown') {
                                event.preventDefault();
                                if (index >= 0 && index < flatHits.length - 1) focusHit(index + 1);
                              } else if (event.key === 'ArrowUp') {
                                event.preventDefault();
                                if (index <= 0) searchInputRef.current?.focus();
                                else focusHit(index - 1);
                              } else if (event.key === 'Escape') {
                                // 与搜索框一致：有字时 Esc 只清空并回到搜索框，不冒泡成「退出设置」
                                event.preventDefault();
                                event.stopPropagation();
                                setSettingsQuery('');
                                searchInputRef.current?.focus();
                              }
                            }}
                            onClick={() => {
                              openCategory(category.id);
                              setFlashRowId(hit.id);
                            }}
                            className={cn(
                              'block w-full rounded-md pr-3 text-left text-xs text-muted-foreground hover:bg-background/60 hover:text-foreground',
                              category.sub ? 'pl-14' : 'pl-9',
                              isMobile ? 'py-2' : 'py-1'
                            )}
                          >
                            <span className="block truncate">{t(hit.title)}</span>
                            <span className="block truncate text-[10px] text-muted-foreground/70">
                              {settingsEntryPath(hit, t, false)}
                            </span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
          {embedded.footer}
        </nav>
      )}
      {/* 和工作区侧栏同一个手柄、同一个宽度值：在哪边拖，另一边都跟着变 */}
      {showList && embedded.onNavResize && !isMobile && (
        <div data-enso="settings-nav-resize" className="flex shrink-0">
          <ResizeHandle edge onResize={embedded.onNavResize} />
        </div>
      )}

      {/* 右侧：设置面板 */}
      {showContent && (
        <div
          data-enso="settings-content"
          className={cn(
            'flex min-w-0 flex-1 flex-col',
            !isMobile &&
              'mr-[8px] mb-[8px] overflow-hidden rounded-[10px] bg-background shadow-surface'
          )}
        >
          <div
            ref={scrollRef}
            data-enso="settings-scroll"
            onScroll={rememberScroll}
            className={cn('min-h-0 flex-1 overflow-y-auto', isMobile ? 'px-4 pb-6' : 'p-6')}
          >
            {isMobile && (
              <button
                type="button"
                data-enso="settings-detail-back"
                onClick={() => setMobileList(true)}
                className="sticky top-0 z-10 -mx-4 mb-3 flex min-h-11 w-[calc(100%+2rem)] items-center gap-1 border-b border-border/70 bg-background/95 px-2 py-2.5 text-sm font-medium backdrop-blur-md"
              >
                <ChevronLeft className="h-5 w-5 text-muted-foreground" />
                {activeLabel ? t(activeLabel) : null}
              </button>
            )}
            {activeCategory === 'general' && <GeneralSettings />}
            {activeCategory === 'shortcuts' && <KeybindingsSettings />}
            {activeCategory === 'appearance' && (
              <AppearanceSettings onOpenPlugins={() => openCategory('plugins')} />
            )}
            {activeCategory === 'conversation' && <ConversationSettings revealRowId={flashRowId} />}
            {activeCategory === 'terminal' && <TerminalSettings />}
            {activeCategory === 'runtime' && <RuntimeSettings />}
            {activeCategory === 'providers' && <ProvidersSettings revealRowId={flashRowId} />}
            {activeCategory === 'skills' && <SkillsSettings />}
            {activeCategory === 'plugins' && (
              <EnsoPluginsSettings
                requestedInstallUrl={pluginInstallUrl}
                onRequestedInstallUrlConsumed={() => setPluginInstallUrl(null)}
                focusPluginId={focusPluginId}
                onFocusPluginConsumed={() => setFocusPluginId(null)}
                requestedMarketQuery={marketQuery}
                onRequestedMarketQueryConsumed={() => setMarketQuery(null)}
              />
            )}
            {activeCategory === 'mcp' && <McpSettings />}
            {activeCategory === 'instructions' && <InstructionsSettings />}
            {activeCategory === 'presets' && <PresetsSettings />}
            {activeCategory === 'agents' && <AgentTypesSettings />}
            {activeCategory === 'workflows' && <WorkflowsSettings />}
            {activeCategory === 'tools' && <BuiltinToolsSettings />}
            {activeCategory === 'memory' && (
              <MemorySettings onLibraryChanged={() => setMemoryRevision((n) => n + 1)}>
                <MemoryKnowledge revision={memoryRevision} />
                <MemoryLibrary revision={memoryRevision} />
              </MemorySettings>
            )}
            {activeCategory === 'phone' && <DevicesSettings />}
            {activeCategory === 'ssh' && <SshSettings />}
            {activeCategory === 'usage' && <UsageSettings />}
            {activeCategory === 'privacy' && <PrivacySettings />}
            {activeCategory === 'resources' && <ResourcesSettings />}
            {activeCategory === 'logs' && <LogsSettings />}
            {activeCategory === 'experimental' && (
              <ExperimentalSettings onOpenBots={() => setActiveCategory('bots')} />
            )}
            {activeCategory === 'bots' && <BotSettings />}
            {activeCategory === 'botTemplates' && <BotTemplatesSettings />}
            {activeCategory === 'secretary' && <SecretarySettings />}
            {activeCategory === 'contacts' && <ContactsSettings />}
          </div>
        </div>
      )}
    </div>
  );
}
