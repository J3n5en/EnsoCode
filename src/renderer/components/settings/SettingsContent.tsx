import type { SettingsDeepLink } from '@shared/settingsDeepLink';
import {
  BarChart3,
  Bot,
  FileText,
  Keyboard,
  Layers,
  Palette,
  Plug,
  Server,
  Settings,
  Smartphone,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react';
import * as React from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { AgentTypesSettings } from './AgentTypesSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { BuiltinToolsSettings } from './BuiltinToolsSettings';
import type { SettingsCategory } from './constants';
import { DevicesSettings } from './DevicesSettings';
import { GeneralSettings } from './GeneralSettings';
import { InstructionsSettings } from './InstructionsSettings';
import { KeybindingsSettings } from './KeybindingsSettings';
import { McpSettings } from './McpSettings';
import { PresetsSettings } from './PresetsSettings';
import { ProvidersSettings } from './ProvidersSettings';
import { SkillsSettings } from './SkillsSettings';
import { SshSettings } from './SshSettings';
import { UsageSettings } from './UsageSettings';

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

  const categories: Array<{ id: SettingsCategory; icon: React.ElementType; label: string }> = [
    { id: 'general', icon: Settings, label: t('General') },
    { id: 'shortcuts', icon: Keyboard, label: t('Shortcuts') },
    { id: 'appearance', icon: Palette, label: t('Appearance') },
    { id: 'providers', icon: Server, label: t('Model Providers') },
    { id: 'presets', icon: Layers, label: t('Presets') },
    { id: 'agents', icon: Bot, label: t('Agent types') },
    { id: 'tools', icon: Wrench, label: t('Built-in tools') },
    { id: 'skills', icon: Sparkles, label: t('Skills') },
    { id: 'mcp', icon: Plug, label: t('MCP Servers') },
    { id: 'instructions', icon: FileText, label: t('Instruction Files') },
    { id: 'phone', icon: Smartphone, label: t('Devices') },
    { id: 'ssh', icon: Terminal, label: t('SSH') },
    { id: 'usage', icon: BarChart3, label: t('Usage') },
  ];

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
        {activeCategory === 'mcp' && <McpSettings />}
        {activeCategory === 'instructions' && <InstructionsSettings />}
        {activeCategory === 'presets' && <PresetsSettings />}
        {activeCategory === 'agents' && <AgentTypesSettings />}
        {activeCategory === 'tools' && <BuiltinToolsSettings />}
        {activeCategory === 'phone' && <DevicesSettings />}
        {activeCategory === 'ssh' && <SshSettings />}
        {activeCategory === 'usage' && <UsageSettings />}
      </div>
    </div>
  );
}
