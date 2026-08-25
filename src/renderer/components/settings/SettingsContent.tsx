import { FileText, Layers, Palette, Plug, Server, Settings, Sparkles } from 'lucide-react';
import * as React from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { AppearanceSettings } from './AppearanceSettings';
import type { SettingsCategory } from './constants';
import { GeneralSettings } from './GeneralSettings';
import { InstructionsSettings } from './InstructionsSettings';
import { McpSettings } from './McpSettings';
import { PresetsSettings } from './PresetsSettings';
import { ProvidersSettings } from './ProvidersSettings';
import { SkillsSettings } from './SkillsSettings';

export function SettingsContent() {
  const { t } = useI18n();
  const [activeCategory, setActiveCategory] = React.useState<SettingsCategory>('general');

  const categories: Array<{ id: SettingsCategory; icon: React.ElementType; label: string }> = [
    { id: 'general', icon: Settings, label: t('General') },
    { id: 'appearance', icon: Palette, label: t('Appearance') },
    { id: 'providers', icon: Server, label: t('Model Providers') },
    { id: 'skills', icon: Sparkles, label: t('Skills') },
    { id: 'mcp', icon: Plug, label: t('MCP Servers') },
    { id: 'instructions', icon: FileText, label: t('Instruction Files') },
    { id: 'presets', icon: Layers, label: t('Presets') },
  ];

  return (
    <div className="flex h-full w-full">
      {/* Left: Category List */}
      <nav className="w-48 shrink-0 space-y-1 border-r p-2">
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
        {activeCategory === 'appearance' && <AppearanceSettings />}
        {activeCategory === 'providers' && <ProvidersSettings />}
        {activeCategory === 'skills' && <SkillsSettings />}
        {activeCategory === 'mcp' && <McpSettings />}
        {activeCategory === 'instructions' && <InstructionsSettings />}
        {activeCategory === 'presets' && <PresetsSettings />}
      </div>
    </div>
  );
}
