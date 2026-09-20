import { BUILTIN_TOOLS, EDIT_MODES, type EditMode, isEditMode } from '@shared/types';
import type { BrowserClearKind } from '@shared/types/browser';
import { Globe, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import {
  enabledOccupancyTotal,
  OccupancyEnabledTotal,
  OccupancyMark,
  useOccupancyRows,
} from './OccupancyMark';

const EDIT_MODE_LABEL: Record<EditMode, string> = {
  replace: 'Text replacement',
  apply_patch: 'Apply patch (default)',
};

export function BuiltinToolsSettings() {
  const { t } = useI18n();
  const disabled = useSettingsStore((state) => state.disabledBuiltinTools);
  const toggle = useSettingsStore((state) => state.toggleBuiltinTool);
  const exploreFoldEnabled = useSettingsStore((state) => state.exploreFoldEnabled);
  const setExploreFoldEnabled = useSettingsStore((state) => state.setExploreFoldEnabled);
  const rtkEnabled = useSettingsStore((state) => state.rtkEnabled);
  const setRtkEnabled = useSettingsStore((state) => state.setRtkEnabled);
  const editMode = useSettingsStore((state) => state.editMode);
  const setEditMode = useSettingsStore((state) => state.setEditMode);
  const occupancy = useOccupancyRows(
    BUILTIN_TOOLS.map((tool) => tool.id),
    () => window.electronAPI.assets.builtinToolOccupancy()
  );
  const enabledTokens = enabledOccupancyTotal(
    BUILTIN_TOOLS.filter((tool) => !disabled.includes(tool.id)).map((tool) => tool.id),
    occupancy.rows
  );
  const [cleared, setCleared] = useState<BrowserClearKind | null>(null);
  const clear = async (kind: BrowserClearKind) => {
    await window.electronAPI.browser.clearData(kind);
    setCleared(kind);
    setTimeout(() => setCleared(null), 2000);
  };

  return (
    <div className="space-y-6">
      <div data-settings-row="tools.root">
        <h3 className="font-medium text-lg">
          {t('Built-in tools')}
          <OccupancyEnabledTotal tokens={enabledTokens} />
        </h3>
        <p className="text-muted-foreground text-sm">
          {t('Toggle the built-in tools available to agents.')}
        </p>
      </div>

      <div className="space-y-2">
        {BUILTIN_TOOLS.map((tool) => (
          <div key={tool.id} className="flex items-center gap-3 rounded-md border px-3 py-2.5">
            <Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t(tool.name)}</p>
              <p className="text-muted-foreground text-xs">{t(tool.description)}</p>
            </div>
            <OccupancyMark
              row={occupancy.rows[tool.id]}
              pending={occupancy.pending && !occupancy.rows[tool.id]}
            />
            <Switch
              checked={!disabled.includes(tool.id)}
              onCheckedChange={(checked) => toggle(tool.id, checked)}
            />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
        <div>
          <p className="font-medium text-sm">{t('Explore fold')}</p>
          <p className="text-muted-foreground text-xs">
            {t(
              'Let the agent mark exploratory reads and keep only a short report in later model context. Timeline stays intact.'
            )}
          </p>
        </div>
        <Switch checked={exploreFoldEnabled} onCheckedChange={setExploreFoldEnabled} />
      </div>

      <div
        className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5"
        data-settings-row="tools.rtkEnabled"
      >
        <div className="min-w-0">
          <p className="font-medium text-sm">{t('RTK command compression')}</p>
          <p className="text-muted-foreground text-xs">
            {t(
              'Compress supported command output before it enters the model context. Takes effect on new conversations.'
            )}
          </p>
        </div>
        <Switch checked={rtkEnabled} onCheckedChange={setRtkEnabled} />
      </div>

      <div className="space-y-2 rounded-lg border px-3 py-2.5" data-settings-row="tools.editMode">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-medium text-sm">{t('File edit mode')}</p>
            <p className="text-muted-foreground text-xs">
              {t(
                'Choose how files are modified. Apply patch is the default. New and cold-restored sessions use this mode; already warm sessions keep their current mode.'
              )}
            </p>
          </div>
          <Select
            items={Object.fromEntries(EDIT_MODES.map((mode) => [mode, t(EDIT_MODE_LABEL[mode])]))}
            value={editMode}
            onValueChange={(value) => {
              if (isEditMode(value)) setEditMode(value);
            }}
          >
            <SelectTrigger className="w-44 shrink-0" aria-label={t('File edit mode')}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {EDIT_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(EDIT_MODE_LABEL[mode])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      <div className="rounded-md border px-3 py-2.5">
        <div className="flex items-center gap-3">
          <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t('Browser data')}</p>
            <p className="text-muted-foreground text-xs">
              {t('Cookies and site storage of the built-in browser, separate from the app itself.')}
            </p>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 pl-7">
          {(['cookies', 'cache', 'all'] as const).map((kind) => (
            <Button key={kind} variant="outline" size="sm" onClick={() => void clear(kind)}>
              {cleared === kind
                ? t('Cleared')
                : kind === 'cookies'
                  ? t('Clear cookies')
                  : kind === 'cache'
                    ? t('Clear cache')
                    : t('Clear all browsing data')}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
