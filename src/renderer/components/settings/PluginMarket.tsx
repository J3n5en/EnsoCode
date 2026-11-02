import type { ExtensionPluginMarketList } from '@shared/extensionPlugins/types';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { pluginPermissionLabel } from '@/plugins/pluginMeta';

export function PluginMarket({
  disabled,
  installedKey,
  onInstall,
}: {
  disabled: boolean;
  /** 已装插件版本变化时刷新安装状态 */
  installedKey: string;
  onInstall: (id: string) => void;
}) {
  const { t } = useI18n();
  const api = window.electronAPI.extensionPlugins;
  const [list, setList] = React.useState<ExtensionPluginMarketList | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const load = React.useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      try {
        setList(await api.marketList(refresh));
      } catch (e) {
        setList({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          chinaMirror: false,
        });
      } finally {
        setLoading(false);
      }
    },
    [api]
  );

  React.useEffect(() => {
    void installedKey;
    void load(false);
  }, [load, installedKey]);

  const setMirror = async (on: boolean) => {
    await api.setMarketChinaMirror(on);
    await load(true);
  };

  const q = query.trim().toLowerCase();
  const plugins =
    list?.ok === true
      ? list.plugins.filter(
          (p) =>
            !q || [p.id, p.name, p.description, ...p.tags].some((s) => s.toLowerCase().includes(q))
        )
      : [];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          value={query}
          placeholder={t('Search plugins')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
          <Switch
            checked={list?.chinaMirror ?? false}
            disabled={loading}
            onCheckedChange={(on) => void setMirror(on)}
          />
          {t('China mirror')}
        </label>
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load(true)}>
          {loading ? <Spinner /> : t('Refresh')}
        </Button>
      </div>
      {list?.ok === false && <p className="text-destructive text-sm">{list.error}</p>}
      {list?.ok === true && list.stale && (
        <p className="text-muted-foreground text-xs">
          {t('Could not reach the marketplace; showing the last saved list.')}
        </p>
      )}
      {list?.ok === true && plugins.length === 0 && (
        <p className="text-muted-foreground text-sm">{t('No matching plugins')}</p>
      )}
      {plugins.map((p) => (
        <div key={p.id} className="flex items-start justify-between gap-3 py-1">
          <div className="min-w-0 space-y-0.5">
            <p className="truncate text-sm">
              {p.name}
              <span className="ml-2 text-muted-foreground text-xs">{p.latest}</span>
              <Badge variant={p.tier === 'official' ? 'secondary' : 'outline'} className="ml-2">
                {p.tier === 'official' ? t('Official') : t('Community')}
              </Badge>
            </p>
            {p.description && <p className="text-muted-foreground text-xs">{p.description}</p>}
            {p.permissions.length > 0 && (
              <p className="text-muted-foreground text-xs">
                {p.permissions.map((perm) => pluginPermissionLabel(perm)).join('、')}
              </p>
            )}
          </div>
          {p.installedVersion && !p.updateAvailable ? (
            <span className="shrink-0 text-muted-foreground text-xs">{t('Installed')}</span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={disabled}
              onClick={() => onInstall(p.id)}
            >
              {p.updateAvailable ? t('Update') : t('Install')}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
