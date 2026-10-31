import type {
  ExtensionPluginConfigField,
  ExtensionPluginInstallPreview,
  ExtensionPluginSummary,
} from '@shared/extensionPlugins/types';
import type { InstalledPluginInfo, PluginComponentSummary, PluginEntry } from '@shared/types';
import { ChevronRight, Puzzle, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { NewSessionBadge } from './NewSessionBadge';

/** 插件配置表单：密钥不回显，留空保持不变 */
function ExtensionPluginConfigForm({ pluginId }: { pluginId: string }) {
  const { t } = useI18n();
  const [fields, setFields] = React.useState<ExtensionPluginConfigField[]>([]);
  const [draft, setDraft] = React.useState<Record<string, string | null>>({});
  const [message, setMessage] = React.useState<{ error: boolean; text: string } | null>(null);

  const load = React.useCallback(async () => {
    const result = await window.electronAPI.extensionPlugins.configGet(pluginId);
    if (result.ok) setFields(result.fields);
    else setMessage({ error: true, text: result.error });
    setDraft({});
  }, [pluginId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const patch = Object.fromEntries(
      Object.entries(draft).filter(([key, value]) => {
        const field = fields.find((f) => f.key === key);
        return value === null || !(field?.secret && value === '');
      })
    );
    const result = await window.electronAPI.extensionPlugins.configSet(pluginId, patch);
    setMessage(
      result.ok
        ? { error: false, text: t('Saved. New calls use it right away.') }
        : { error: true, text: result.error ?? '' }
    );
    if (result.ok) await load();
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      {fields.map((field) => (
        <div key={field.key} className="space-y-1">
          <p className="text-sm">
            {field.title}
            <span className="ml-2 font-mono text-muted-foreground text-xs">{field.key}</span>
          </p>
          {field.description && (
            <p className="text-muted-foreground text-xs">{field.description}</p>
          )}
          <div className="flex items-center gap-2">
            <Input
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              value={draft[field.key] ?? (field.secret ? '' : (field.value ?? ''))}
              placeholder={
                field.secret && field.set ? t('Set (leave blank to keep)') : t('Not set')
              }
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, [field.key]: event.target.value }))
              }
            />
            {field.set && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraft((prev) => ({ ...prev, [field.key]: null }))}
              >
                {t('Clear value')}
              </Button>
            )}
          </div>
        </div>
      ))}
      {message && (
        <p className={cn('text-xs', message.error ? 'text-destructive' : 'text-muted-foreground')}>
          {message.text}
        </p>
      )}
      <Button size="sm" disabled={Object.keys(draft).length === 0} onClick={() => void save()}>
        {t('Save')}
      </Button>
    </div>
  );
}

/** Enso 自己的插件：安装时展示权限并征得同意，更新扩大授权要重新同意 */
function ExtensionPluginsSection() {
  const { t } = useI18n();
  const [plugins, setPlugins] = React.useState<ExtensionPluginSummary[]>([]);
  const [preview, setPreview] = React.useState<ExtensionPluginInstallPreview | null>(null);
  const [configuring, setConfiguring] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState('');
  const [downloading, setDownloading] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      setPlugins(await window.electronAPI.extensionPlugins.list());
    } catch {
      setPlugins([]);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    return window.electronAPI.extensionPlugins.onChanged(() => void refresh());
  }, [refresh]);

  const stage = async (kind: 'dir' | 'zip') => {
    setError(null);
    if (preview) void window.electronAPI.extensionPlugins.discard(preview.token);
    setPreview(null);
    const result = await window.electronAPI.extensionPlugins.pickAndStage(kind);
    if (!result.ok) setError(result.error);
    else if (!('cancelled' in result)) setPreview(result.preview);
  };

  const stageUrl = async () => {
    const value = url.trim();
    if (!value) return;
    setError(null);
    setDownloading(true);
    if (preview) void window.electronAPI.extensionPlugins.discard(preview.token);
    setPreview(null);
    const result = await window.electronAPI.extensionPlugins.stageFromUrl(value).finally(() => {
      setDownloading(false);
    });
    if (!result.ok) setError(result.error);
    else setPreview(result.preview);
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    const result = await window.electronAPI.extensionPlugins.commit(preview.token);
    setBusy(false);
    if (!result.ok) setError(result.error ?? t('Install failed'));
    setPreview(null);
  };

  const discard = () => {
    if (preview) void window.electronAPI.extensionPlugins.discard(preview.token);
    setPreview(null);
  };

  return (
    <div className="space-y-3" data-settings-row="plugins.enso">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="font-medium text-lg">
            {t('Enso plugins')}
            <NewSessionBadge />
          </h3>
          <p className="text-muted-foreground text-sm">
            {t(
              'Installing a plugin lets it run code on this machine. Review what it asks for before confirming.'
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || downloading}
            onClick={() => void stage('dir')}
          >
            {t('Install from folder')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || downloading}
            onClick={() => void stage('zip')}
          >
            {t('Install from zip')}
          </Button>
        </div>
      </div>
      <div className="flex gap-2">
        <Input
          value={url}
          placeholder={t('https://github.com/owner/repo')}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void stageUrl();
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || downloading || url.trim() === ''}
          onClick={() => void stageUrl()}
        >
          {downloading ? <Spinner /> : t('Install from URL')}
        </Button>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      {preview && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="font-medium text-sm">
            {preview.name} {preview.version}
            {preview.existingVersion && (
              <span className="ml-2 text-muted-foreground">
                {t('updating from {{version}}', { version: preview.existingVersion })}
              </span>
            )}
          </p>
          <p className="text-muted-foreground text-xs">
            {preview.permissions.length > 0
              ? preview.permissions.join(' · ')
              : t('No special permissions')}
          </p>
          {preview.mcpServers.map((server) => (
            <p key={server.name} className="font-mono text-xs">
              {server.command} {server.args.join(' ')}
            </p>
          ))}
          {preview.mcpTools.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {t('Host MCP tools it may call')}：
              <span className="font-mono">{preview.mcpTools.join(', ')}</span>
            </p>
          )}
          {preview.warnings.map((warning) => (
            <p key={warning} className="text-muted-foreground text-xs">
              {warning}
            </p>
          ))}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void commit()}>
              {busy ? <Spinner /> : t('Install')}
            </Button>
            <Button size="sm" variant="ghost" onClick={discard}>
              {t('Cancel')}
            </Button>
          </div>
        </div>
      )}
      {plugins.map((plugin) => (
        <div key={plugin.id} className="space-y-2 py-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm">
                {plugin.name}
                <span className="ml-2 text-muted-foreground text-xs">{plugin.version}</span>
                {plugin.state === 'crashed' && (
                  <Badge variant="destructive" className="ml-2">
                    {t('Stopped after crashes')}
                  </Badge>
                )}
              </p>
              {plugin.pendingVersion && (
                <p className="text-muted-foreground text-xs">
                  {t('{{version}} asks for more and is waiting for approval', {
                    version: plugin.pendingVersion,
                  })}
                  <button
                    type="button"
                    className="ml-2 underline"
                    onClick={() =>
                      void window.electronAPI.extensionPlugins.approvePending(plugin.id)
                    }
                  >
                    {t('Allow')}
                  </button>
                  <button
                    type="button"
                    className="ml-2 underline"
                    onClick={() =>
                      void window.electronAPI.extensionPlugins.rejectPending(plugin.id)
                    }
                  >
                    {t('Keep current')}
                  </button>
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {plugin.configurable && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('Configure')}
                  title={t('Configure')}
                  onClick={() => setConfiguring((id) => (id === plugin.id ? null : plugin.id))}
                >
                  <Settings2 className="size-4" />
                </Button>
              )}
              <Switch
                checked={plugin.state === 'enabled'}
                onCheckedChange={(enabled) =>
                  void window.electronAPI.extensionPlugins.setEnabled(plugin.id, enabled)
                }
              />
              <Button
                size="icon"
                variant="ghost"
                onClick={() => void window.electronAPI.extensionPlugins.uninstall(plugin.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
          {configuring === plugin.id && <ExtensionPluginConfigForm pluginId={plugin.id} />}
        </div>
      ))}
    </div>
  );
}

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
      <ExtensionPluginsSection />
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
