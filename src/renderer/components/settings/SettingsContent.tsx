import type { SettingsDeepLink } from '@shared/settingsDeepLink';
import {
  BarChart3,
  Bot,
  BotMessageSquare,
  Brain,
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
  Server,
  Settings,
  Smartphone,
  Sparkles,
  Terminal,
  Workflow,
  Wrench,
} from 'lucide-react';
import * as React from 'react';
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
import { PluginsSettings } from './PluginsSettings';
import { PresetsSettings } from './PresetsSettings';
import { ProvidersSettings } from './ProvidersSettings';
import { ResourcesSettings } from './ResourcesSettings';
import { SkillsSettings } from './SkillsSettings';
import { SshSettings } from './SshSettings';
import { resolveActiveCategory, visibleCategories } from './settingsCategories';
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
  // 提炼写入记忆后让记忆库重新拉数据（两个组件各自持有列表）
  const [memoryRevision, setMemoryRevision] = React.useState(0);
  const disabledBuiltinTools = useSettingsStore((state) => state.disabledBuiltinTools);
  const botModeEnabled = useSettingsStore((state) => state.botModeEnabled);
  // 水合前 botModeEnabled 恒为 false：此时不据此把指向 Bot 页的深链改落到实验页
  const hydrated = React.useSyncExternalStore(
    (onChange) => useSettingsStore.persist?.onFinishHydration?.(onChange) ?? (() => {}),
    () => useSettingsStore.persist?.hasHydrated?.() ?? true
  );

  const applyLink = React.useCallback((link: SettingsDeepLink) => {
    setActiveCategory(link.category);
    setFlashRowId(link.rowId);
  }, []);

  React.useEffect(() => {
    void window.electronAPI.window.consumeSettingsDeepLink().then((link) => {
      if (link) applyLink(link);
    });
    return window.electronAPI.window.onSettingsDeepLink(applyLink);
  }, [applyLink]);

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
    { id: 'general', icon: Settings, label: t('General') },
    { id: 'shortcuts', icon: Keyboard, label: t('Shortcuts') },
    { id: 'voice', icon: Mic, label: t('Voice input') },
    { id: 'appearance', icon: Palette, label: t('Appearance') },
    { id: 'providers', icon: Server, label: t('Model Providers') },
    { id: 'presets', icon: Layers, label: t('Presets') },
    { id: 'agents', icon: Bot, label: t('Agent types') },
    { id: 'tools', icon: Wrench, label: t('Built-in tools') },
    { id: 'workflows', icon: Workflow, label: t('Workflows') },
    { id: 'memory', icon: Brain, label: t('Memory') },
    { id: 'skills', icon: Sparkles, label: t('Skills') },
    { id: 'plugins', icon: Puzzle, label: t('Plugins') },
    { id: 'mcp', icon: Plug, label: t('MCP Servers') },
    { id: 'instructions', icon: FileText, label: t('Instruction Files') },
    { id: 'phone', icon: Smartphone, label: t('Devices') },
    { id: 'ssh', icon: Terminal, label: t('SSH') },
    { id: 'usage', icon: BarChart3, label: t('Usage') },
    { id: 'resources', icon: Gauge, label: t('Resources') },
    { id: 'experimental', icon: FlaskConical, label: t('Experimental') },
    { id: 'bots', icon: BotMessageSquare, label: t('Bot mode'), sub: true },
    { id: 'botTemplates', icon: LayoutTemplate, label: t('Bot templates'), sub: true },
  ];
  const categories = visibleCategories(allCategories, disabledBuiltinTools, botModeEnabled);

  // 关掉 memory 工具时当前页会消失（deeplink 也可能指向未启用的功能），落到能重新打开它的地方
  const resolvedCategory = resolveActiveCategory(
    activeCategory,
    disabledBuiltinTools,
    botModeEnabled || !hydrated
  );
  React.useEffect(() => {
    if (resolvedCategory !== activeCategory) setActiveCategory(resolvedCategory);
  }, [resolvedCategory, activeCategory]);

  return (
    <div className="flex h-full w-full">
      {/* Left: Category List */}
      <nav className="w-48 shrink-0 space-y-1 overflow-y-auto border-r p-2">
        {categories.map((category) => (
          <button
            type="button"
            key={category.id}
            onClick={() => setActiveCategory(category.id)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
              category.sub && 'pl-8',
              activeCategory === category.id
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            )}
          >
            <category.icon className="h-4 w-4" />
            {category.label}
          </button>
        ))}
      </nav>

      {/* Right: Settings Panel */}
      <div className="flex-1 min-w-0 overflow-y-auto p-6">
        {activeCategory === 'general' && <GeneralSettings />}
        {activeCategory === 'shortcuts' && <KeybindingsSettings />}
        {activeCategory === 'appearance' && <AppearanceSettings />}
        {activeCategory === 'providers' && <ProvidersSettings />}
        {activeCategory === 'skills' && <SkillsSettings />}
        {activeCategory === 'plugins' && <PluginsSettings />}
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
        {activeCategory === 'resources' && <ResourcesSettings />}
        {activeCategory === 'voice' && <VoiceInputSettings />}
        {activeCategory === 'experimental' && (
          <ExperimentalSettings onOpenBots={() => setActiveCategory('bots')} />
        )}
        {activeCategory === 'bots' && <BotSettings />}
        {activeCategory === 'botTemplates' && <BotTemplatesSettings />}
      </div>
    </div>
  );
}
