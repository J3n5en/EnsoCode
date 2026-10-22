import type { InstalledPluginInfo, PluginComponentSummary, PluginEntry } from '@shared/types';
import { ChevronRight, Puzzle, RefreshCw, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { NewSessionBadge } from './NewSessionBadge';

function componentCounts(
  components: PluginComponentSummary,
  t: ReturnType<typeof useI18n>['t']
): string {
  return [
    [components.skills.length, t('Skills')],
    [components.commands.length, t('Commands')],
    [components.agents.length, t('Agent types')],
    [components.mcpServers.length, 'MCP'],
    [components.hooks.length, 'Hooks'],
  ]
    .filter(([count]) => (count as number) > 0)
    .map(([count, label]) => `${label} ${count}`)
    .join(' · ');
}

function Detail({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-0.5">
      <p className="font-medium text-muted-foreground text-xs">{label}</p>
      {items.map((item) => (
        <p key={item} className="break-all font-mono text-[11px]">
          {item}
        </p>
      ))}
    </div>
  );
}

function PluginRow({
  plugin,
  entry,
  onToggle,
}: {
  plugin: InstalledPluginInfo;
  entry?: PluginEntry;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const { components } = plugin;
  const counts = componentCounts(components, t);
  return (
    <div className="rounded-md border" data-settings-row={`plugins.${plugin.key}`}>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90'
            )}
          />
          <span className="shrink-0 font-medium text-sm">{plugin.name}</span>
          {plugin.version && (
            <Badge variant="outline" className="shrink-0 text-[11px]">
              {plugin.version}
            </Badge>
          )}
          {plugin.marketplace && (
            <Badge variant="secondary" className="shrink-0 text-[11px]">
              {plugin.marketplace}
            </Badge>
          )}
          <span className="min-w-0 truncate text-muted-foreground text-xs">
            {counts ||
              (components.unsupported.length > 0
                ? `${t('Not supported')}: ${components.unsupported.join(', ')}`
                : t('No supported components'))}
          </span>
        </button>
        <Switch checked={entry?.enabled === true} onCheckedChange={onToggle} />
      </div>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {plugin.description && (
            <p className="text-muted-foreground text-xs">{plugin.description}</p>
          )}
          <Detail label={t('Skills')} items={components.skills} />
          <Detail label={t('Commands')} items={components.commands.map((name) => `/${name}`)} />
          <Detail label={t('Agent types')} items={components.agents} />
          <Detail
            label={t('MCP servers (run when a session starts)')}
            items={components.mcpServers.map((server) => `${server.name}: ${server.target}`)}
          />
          <Detail
            label={t('Hooks (run automatically on local sessions)')}
            items={components.hooks.map((hook) => `${hook.event}: ${hook.command}`)}
          />
          <Detail label={t('Not supported')} items={components.unsupported} />
        </div>
      )}
    </div>
  );
}

export function PluginsSettings() {
  const { t } = useI18n();
  const entries = useSettingsStore((state) => state.plugins);
  const addPlugins = useSettingsStore((state) => state.addPlugins);
  const setPluginEnabled = useSettingsStore((state) => state.setPluginEnabled);
  const removePlugin = useSettingsStore((state) => state.removePlugin);
  const [installed, setInstalled] = React.useState<InstalledPluginInfo[] | null>(null);

  const refresh = React.useCallback(async () => {
    setInstalled(null);
    try {
      setInstalled(await window.electronAPI.assets.listInstalledPlugins());
    } catch {
      setInstalled([]);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const installedKeys = new Set((installed ?? []).map((plugin) => plugin.key));
  const missing = installed ? entries.filter((entry) => !installedKeys.has(entry.key)) : [];
  const enabledCount = entries.filter((entry) => entry.enabled).length;

  const toggle = (plugin: InstalledPluginInfo, enabled: boolean) => {
    const entry = byKey.get(plugin.key);
    if (entry) {
      setPluginEnabled(entry.id, enabled);
      return;
    }
    addPlugins([
      {
        id: crypto.randomUUID(),
        key: plugin.key,
        name: plugin.name,
        description: plugin.description,
        ...(plugin.version ? { version: plugin.version } : {}),
        source: plugin.marketplace || 'Claude Code',
        enabled,
      },
    ]);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4" data-settings-row="plugins.root">
        <div>
          <h3 className="font-medium text-lg">
            {t('Plugins')}
            <NewSessionBadge />
            {enabledCount > 0 && (
              <span className="ml-2 font-normal text-muted-foreground text-xs">
                {t('{{count}} enabled', { count: enabledCount })}
              </span>
            )}
          </h3>
          <p className="text-muted-foreground text-sm">
            {t(
              'Plugins installed in Claude Code. Each one is switched on or off as a whole here; changes apply to new sessions.'
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={installed === null}>
          <RefreshCw className="mr-1.5 h-4 w-4" />
          {t('Rescan')}
        </Button>
      </div>

      {installed === null ? (
        <div className="flex justify-center py-10">
          <Spinner className="size-5" />
        </div>
      ) : installed.length === 0 ? (
        <div className="rounded-md border border-dashed px-3 py-8 text-center">
          <Puzzle className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 font-medium text-sm">{t('No Claude Code plugins found')}</p>
          <p className="mt-1 text-muted-foreground text-xs">
            {t('Install plugins with /plugin in Claude Code, then rescan.')}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {installed.map((plugin) => (
            <PluginRow
              key={plugin.key}
              plugin={plugin}
              entry={byKey.get(plugin.key)}
              onToggle={(enabled) => toggle(plugin, enabled)}
            />
          ))}
        </div>
      )}

      {missing.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium text-muted-foreground text-xs">
            {t('No longer installed in Claude Code')}
          </p>
          {missing.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-accent/50"
            >
              <span className="text-muted-foreground text-sm line-through">{entry.name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => removePlugin(entry.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
