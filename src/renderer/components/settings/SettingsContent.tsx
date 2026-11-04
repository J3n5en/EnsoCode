import type { SettingsDeepLink } from '@shared/settingsDeepLink';
import {
  BarChart3,
  Blocks,
  Bot,
  BotMessageSquare,
  Brain,
  ChevronLeft,
  ChevronRight,
  FileText,
  FlaskConical,
  Gauge,
  Keyboard,
  Layers,
  LayoutTemplate,
  Mic,
  Palette,
  Plug,
  Puzzle,
  Search,
  Server,
  Settings,
  Shield,
  Smartphone,
  Sparkles,
  Terminal,
  Workflow,
  Wrench,
} from 'lucide-react';
import * as React from 'react';
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
import type { SettingsCategory } from './constants';
import { DevicesSettings } from './DevicesSettings';
import { ExperimentalSettings } from './ExperimentalSettings';
import { GeneralSettings } from './GeneralSettings';
import { InstructionsSettings } from './InstructionsSettings';
import { KeybindingsSettings } from './KeybindingsSettings';
import { McpSettings } from './McpSettings';
import { MemoryKnowledge } from './MemoryKnowledge';
import { MemoryLibrary } from './MemoryLibrary';
import { MemorySettings } from './MemorySettings';
import { ClaudePluginsSettings, EnsoPluginsSettings } from './PluginsSettings';
import { PresetsSettings } from './PresetsSettings';
import { PrivacySettings } from './PrivacySettings';
import { ProvidersSettings } from './ProvidersSettings';
import { ResourcesSettings } from './ResourcesSettings';
import { SkillsSettings } from './SkillsSettings';
import { SshSettings } from './SshSettings';
import {
  groupCategories,
  resolveActiveCategory,
  searchCategories,
  visibleCategories,
} from './settingsCategories';
import { UsageSettings } from './UsageSettings';
import { VoiceInputSettings } from './VoiceInputSettings';
import { WorkflowsSettings } from './WorkflowsSettings';

function flashSettingsRow(rowId: string): void {
  window.requestAnimationFrame(() => {
    const el = document.querySelector(`[data-settings-row="${CSS.escape(rowId)}"]`);
    if (!(el instanceof HTMLElement)) return;
    el.scrollIntoView({ block: 'center' });
    el.dataset.settingsFlash = 'true';
    window.setTimeout(() => {
      delete el.dataset.settingsFlash;
    }, 1600);
  });
}

export function SettingsContent() {
  const { t } = useI18n();
  const [activeCategory, setActiveCategory] = React.useState<SettingsCategory>('general');
  const [flashRowId, setFlashRowId] = React.useState<string | null>(null);
  const [pluginInstallUrl, setPluginInstallUrl] = React.useState<string | null>(null);
  // 提炼写入记忆后让记忆库重新拉数据（两个组件各自持有列表）
  const [memoryRevision, setMemoryRevision] = React.useState(0);
  // 窄屏下分类列表与内容逐级进入
  const isMobile = useIsMobile();
  const [mobileList, setMobileList] = React.useState(true);
  const [settingsQuery, setSettingsQuery] = React.useState('');
  const [sshConnections, setSshConnections] = React.useState<Array<{ id: string; name: string }>>(
    []
  );
  const openCategory = (category: SettingsCategory) => {
    setActiveCategory(category);
    setMobileList(false);
  };
  const disabledBuiltinTools = useSettingsStore((state) => state.disabledBuiltinTools);
  const botModeEnabled = useSettingsStore((state) => state.botModeEnabled);
  // 水合前 botModeEnabled 恒为 false：此时不据此把指向 Bot 页的深链改落到实验页
  const hydrated = React.useSyncExternalStore(
    (onChange) => useSettingsStore.persist?.onFinishHydration?.(onChange) ?? (() => {}),
    () => useSettingsStore.persist?.hasHydrated?.() ?? true
  );

  const applyLink = React.useCallback((link: SettingsDeepLink) => {
    setActiveCategory(link.category);
    setMobileList(false);
    setFlashRowId(link.rowId);
    if (link.pluginInstallUrl) setPluginInstallUrl(link.pluginInstallUrl);
  }, []);

  React.useEffect(() => {
    void window.electronAPI.window.consumeSettingsDeepLink().then((link) => {
      if (link) applyLink(link);
    });
    return window.electronAPI.window.onSettingsDeepLink(applyLink);
  }, [applyLink]);

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

  React.useLayoutEffect(() => {
    if (!flashRowId) return;
    flashSettingsRow(flashRowId);
    const timer = window.setTimeout(() => setFlashRowId(null), 1600);
    return () => window.clearTimeout(timer);
  }, [flashRowId]);

  const allCategories: Array<{
    id: SettingsCategory;
    icon: React.ElementType;
    label: string;
    /** 子菜单：缩进挂在父分类下 */
    sub?: boolean;
  }> = [
    { id: 'general', icon: Settings, label: 'General' },
    { id: 'shortcuts', icon: Keyboard, label: 'Shortcuts' },
    { id: 'voice', icon: Mic, label: 'Voice input' },
    { id: 'appearance', icon: Palette, label: 'Appearance' },
    { id: 'providers', icon: Server, label: 'Model Providers' },
    { id: 'presets', icon: Layers, label: 'Presets' },
    { id: 'agents', icon: Bot, label: 'Agent types' },
    { id: 'tools', icon: Wrench, label: 'Built-in tools' },
    { id: 'workflows', icon: Workflow, label: 'Workflows' },
    { id: 'memory', icon: Brain, label: 'Memory' },
    { id: 'privacy', icon: Shield, label: 'Privacy' },
    { id: 'skills', icon: Sparkles, label: 'Skills' },
    { id: 'plugins', icon: Puzzle, label: 'Enso plugins' },
    { id: 'claudePlugins', icon: Blocks, label: 'Claude Code plugins' },
    { id: 'mcp', icon: Plug, label: 'MCP Servers' },
    { id: 'instructions', icon: FileText, label: 'Instruction Files' },
    { id: 'phone', icon: Smartphone, label: 'Devices' },
    { id: 'ssh', icon: Terminal, label: 'SSH' },
    { id: 'usage', icon: BarChart3, label: 'Usage' },
    { id: 'resources', icon: Gauge, label: 'Resources' },
    { id: 'experimental', icon: FlaskConical, label: 'Experimental' },
    { id: 'bots', icon: BotMessageSquare, label: 'Bot mode', sub: true },
    { id: 'botTemplates', icon: LayoutTemplate, label: 'Bot templates', sub: true },
  ];
  const categories = visibleCategories(allCategories, disabledBuiltinTools, botModeEnabled);
  const groupedCategories = groupCategories(
    searchCategories(categories, settingsCatalog, settingsQuery, t)
  );

  // 关掉 memory 工具时当前页会消失（deeplink 也可能指向未启用的功能），落到能重新打开它的地方
  const resolvedCategory = resolveActiveCategory(
    activeCategory,
    disabledBuiltinTools,
    botModeEnabled || !hydrated
  );
  React.useEffect(() => {
    if (resolvedCategory !== activeCategory) setActiveCategory(resolvedCategory);
  }, [resolvedCategory, activeCategory]);

  const showList = !isMobile || mobileList;
  const showContent = !isMobile || !mobileList;
  const activeLabel = categories.find((c) => c.id === activeCategory)?.label;

  return (
    <div className="flex h-full w-full">
      {/* Left: Category List */}
      {showList && (
        <nav
          className={cn('flex min-h-0 shrink-0 flex-col', isMobile ? 'w-full' : 'w-56 border-r')}
        >
          <div className="sticky top-0 z-10 bg-background px-2 pt-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={settingsQuery}
                onChange={(event) => setSettingsQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || settingsQuery.length === 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setSettingsQuery('');
                }}
                placeholder={t('Search settings')}
                className="h-8 w-full rounded-md border bg-transparent pr-2 pl-7 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {settingsQuery.trim() && groupedCategories.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">{t('No results')}</div>
            ) : (
              groupedCategories.map((group, index) => (
                <div key={group.id} className={cn(index > 0 && 'mt-4')}>
                  <div className="px-2 pb-1.5 text-xs font-semibold text-foreground/55">
                    {t(group.label)}
                  </div>
                  <div className="space-y-0.5 rounded-lg bg-muted/60 p-1">
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
                            onClick={() => {
                              openCategory(category.id);
                              setFlashRowId(hit.id);
                            }}
                            className={cn(
                              'block w-full truncate rounded-md pr-3 text-left text-xs text-muted-foreground hover:bg-background/60 hover:text-foreground',
                              category.sub ? 'pl-14' : 'pl-9',
                              isMobile ? 'py-2' : 'py-1'
                            )}
                          >
                            {t(hit.title)}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </nav>
      )}

      {/* Right: Settings Panel */}
      {showContent && (
        <div className={cn('flex-1 min-w-0 overflow-y-auto', isMobile ? 'px-4 pb-6' : 'p-6')}>
          {isMobile && (
            <button
              type="button"
              onClick={() => setMobileList(true)}
              className="sticky top-0 z-10 -mx-4 mb-3 flex w-[calc(100%+2rem)] items-center gap-1 border-b bg-background px-2 py-2.5 text-sm font-medium"
            >
              <ChevronLeft className="h-5 w-5 text-muted-foreground" />
              {activeLabel ? t(activeLabel) : null}
            </button>
          )}
          {activeCategory === 'general' && <GeneralSettings />}
          {activeCategory === 'shortcuts' && <KeybindingsSettings />}
          {activeCategory === 'appearance' && <AppearanceSettings />}
          {activeCategory === 'providers' && <ProvidersSettings />}
          {activeCategory === 'skills' && <SkillsSettings />}
          {activeCategory === 'plugins' && (
            <EnsoPluginsSettings
              requestedInstallUrl={pluginInstallUrl}
              onRequestedInstallUrlConsumed={() => setPluginInstallUrl(null)}
            />
          )}
          {activeCategory === 'claudePlugins' && <ClaudePluginsSettings />}
          {activeCategory === 'mcp' && <McpSettings />}
          {activeCategory === 'instructions' && <InstructionsSettings />}
          {activeCategory === 'presets' && <PresetsSettings />}
          {activeCategory === 'agents' && <AgentTypesSettings />}
          {activeCategory === 'workflows' && <WorkflowsSettings />}
          {activeCategory === 'tools' && <BuiltinToolsSettings />}
          {activeCategory === 'memory' && (
            <div className="space-y-8">
              <MemorySettings onLibraryChanged={() => setMemoryRevision((n) => n + 1)} />
              <MemoryKnowledge revision={memoryRevision} />
              <MemoryLibrary revision={memoryRevision} />
            </div>
          )}
          {activeCategory === 'phone' && <DevicesSettings />}
          {activeCategory === 'ssh' && <SshSettings />}
          {activeCategory === 'usage' && <UsageSettings />}
          {activeCategory === 'privacy' && <PrivacySettings />}
          {activeCategory === 'resources' && <ResourcesSettings />}
          {activeCategory === 'voice' && <VoiceInputSettings />}
          {activeCategory === 'experimental' && (
            <ExperimentalSettings onOpenBots={() => setActiveCategory('bots')} />
          )}
          {activeCategory === 'bots' && <BotSettings />}
          {activeCategory === 'botTemplates' && <BotTemplatesSettings />}
        </div>
      )}
    </div>
  );
}
