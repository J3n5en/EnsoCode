import { BUILTIN_TOOLS } from '@shared/types';
import { Wrench } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';

export function BuiltinToolsSettings() {
  const { t } = useI18n();
  const disabled = useSettingsStore((state) => state.disabledBuiltinTools);
  const toggle = useSettingsStore((state) => state.toggleBuiltinTool);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-medium text-lg">{t('Built-in tools')}</h3>
        <p className="text-muted-foreground text-sm">
          {t('Toggle the built-in tools available to agents. All enabled by default.')}
        </p>
      </div>

      <div className="space-y-2">
        {BUILTIN_TOOLS.map((tool) => (
          <div key={tool.id} className="flex items-center gap-3 rounded-md border px-3 py-2.5">
            <Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{tool.name}</p>
              <p className="text-muted-foreground text-xs">{tool.description}</p>
            </div>
            <Switch
              checked={!disabled.includes(tool.id)}
              onCheckedChange={(checked) => toggle(tool.id, checked)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
