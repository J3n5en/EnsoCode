import type { ExtensionPluginMarketList } from '@shared/extensionPlugins/types';
import { Puzzle } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { pluginPermissionLabel } from '@/plugins/pluginMeta';
import { filterMarketPlugins, marketCategories } from './pluginMarketFilter';

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
  const [category, setCategory] = React.useState<string | null>(null);

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

  const all = list?.ok === true ? list.plugins : [];
  const categories = marketCategories(all);
  const activeCategory = category !== null && categories.includes(category) ? category : null;
  const plugins = filterMarketPlugins(all, { query, category: activeCategory });

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
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1">
          <Button
            size="xs"
            variant={activeCategory === null ? 'secondary' : 'outline'}
            aria-pressed={activeCategory === null}
            onClick={() => setCategory(null)}
          >
            {t('All')}
          </Button>
          {categories.map((tag) => (
            <Button
              key={tag}
              size="xs"
              variant={activeCategory === tag ? 'secondary' : 'outline'}
              aria-pressed={activeCategory === tag}
              onClick={() => setCategory(tag)}
            >
              {tag}
            </Button>
          ))}
        </div>
      )}
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
        <div key={p.id} className="flex items-start gap-3 py-1">
          <MarketIcon src={p.icon} />
          <div className="min-w-0 flex-1 space-y-0.5">
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
          <div className="relative shrink-0">
            <Button
              aria-hidden
              tabIndex={-1}
              size="sm"
              variant="outline"
              className="pointer-events-none invisible"
            >
              {t('Installed')}
            </Button>
            <div className="absolute inset-0 flex items-center justify-center">
              {p.installedVersion && !p.updateAvailable ? (
                <span className="whitespace-nowrap font-medium text-base text-muted-foreground sm:text-sm">
                  {t('Installed')}
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="size-full"
                  disabled={disabled}
                  onClick={() => onInstall(p.id)}
                >
                  {p.updateAvailable ? t('Update') : t('Install')}
                </Button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MarketIcon({ src }: { src?: string }) {
  const [broken, setBroken] = React.useState(false);
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
      {src && !broken ? (
        <img src={src} alt="" className="size-5 object-contain" onError={() => setBroken(true)} />
      ) : (
        <Puzzle className="size-4 text-muted-foreground" />
      )}
    </div>
  );
}
