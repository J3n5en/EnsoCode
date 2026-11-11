import {
  MARKET_CATEGORY_LABELS,
  type MarketCategory,
} from '@shared/extensionPlugins/marketCategories';
import type {
  ExtensionPluginMarketEntry,
  ExtensionPluginMarketList,
} from '@shared/extensionPlugins/types';
import { ArrowLeft, ExternalLink, Puzzle } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { pluginPermissionLabel } from '@/plugins/pluginMeta';
import { nextMarketLoadRequest, openMarketLoadRequest } from './marketLoad';
import { httpHomepage, PluginReadmeBody } from './PluginReadmeDialog';
import { filterMarketPlugins, type MarketSection, marketSections } from './pluginMarketFilter';

const SECTION_LABELS: Record<'all' | 'installed' | 'updates' | 'other', string> = {
  all: '全部',
  installed: '已安装',
  updates: '可更新',
  other: '其他',
};

export const marketSectionLabel = (section: MarketSection): string =>
  section in SECTION_LABELS
    ? SECTION_LABELS[section as keyof typeof SECTION_LABELS]
    : MARKET_CATEGORY_LABELS[section as MarketCategory];

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
  const [section, setSection] = React.useState<MarketSection>('all');
  const [selected, setSelected] = React.useState<string | null>(null);
  const [loadRequest, setLoadRequest] = React.useState(() => openMarketLoadRequest(installedKey));
  const nextRequest = nextMarketLoadRequest(loadRequest, installedKey);
  if (nextRequest !== loadRequest) setLoadRequest(nextRequest);

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
    void load(loadRequest.refresh);
  }, [load, loadRequest]);

  const setMirror = async (on: boolean) => {
    await api.setMarketChinaMirror(on);
    await load(true);
  };

  const all = list?.ok === true ? list.plugins : [];
  const sections = marketSections(all);
  const active = sections.some((item) => item.id === section) ? section : 'all';
  const plugins = filterMarketPlugins(all, { query, section: active });
  const detail = selected ? all.find((p) => p.id === selected) : undefined;

  return (
    <div className="flex h-[min(72vh,720px)] min-h-0 flex-col gap-3 sm:flex-row sm:gap-4">
      <nav
        aria-label="插件分类"
        className="flex shrink-0 gap-1 overflow-x-auto pb-1 sm:block sm:w-36 sm:space-y-0.5 sm:overflow-y-auto sm:pb-0"
      >
        {sections.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={active === item.id}
            onClick={() => {
              setSection(item.id);
              setSelected(null);
            }}
            className={cn(
              'flex shrink-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent sm:w-full',
              active === item.id && 'bg-accent font-medium'
            )}
          >
            <span className="truncate whitespace-nowrap">{marketSectionLabel(item.id)}</span>
            <span className="text-muted-foreground text-xs tabular-nums">{item.count}</span>
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="min-w-40 flex-1"
            value={query}
            placeholder={t('Search plugins')}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(null);
            }}
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
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {detail ? (
            <MarketDetail
              plugin={detail}
              disabled={disabled}
              onBack={() => setSelected(null)}
              onInstall={onInstall}
            />
          ) : list?.ok === true && plugins.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('No matching plugins')}</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {plugins.map((p) => (
                <MarketCard
                  key={p.id}
                  plugin={p}
                  disabled={disabled}
                  onOpen={() => setSelected(p.id)}
                  onInstall={onInstall}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InstallAction({
  plugin,
  disabled,
  onInstall,
}: {
  plugin: ExtensionPluginMarketEntry;
  disabled: boolean;
  onInstall: (id: string) => void;
}) {
  const { t } = useI18n();
  if (plugin.installedVersion && !plugin.updateAvailable)
    return <span className="shrink-0 text-muted-foreground text-xs">{t('Installed')}</span>;
  return (
    <Button
      size="xs"
      variant={plugin.updateAvailable ? 'default' : 'outline'}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onInstall(plugin.id);
      }}
    >
      {plugin.updateAvailable ? t('Update') : t('Install')}
    </Button>
  );
}

function TierBadge({ tier }: { tier: ExtensionPluginMarketEntry['tier'] }) {
  const { t } = useI18n();
  return (
    <Badge variant={tier === 'official' ? 'secondary' : 'outline'} className="text-[11px]">
      {tier === 'official' ? t('Official') : t('Community')}
    </Badge>
  );
}

function MarketCard({
  plugin,
  disabled,
  onOpen,
  onInstall,
}: {
  plugin: ExtensionPluginMarketEntry;
  disabled: boolean;
  onOpen: () => void;
  onInstall: (id: string) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={plugin.name}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className="flex cursor-pointer flex-col gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-accent/50"
    >
      <div className="flex items-start gap-3">
        <MarketIcon src={plugin.icon} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm">
            <span className="truncate font-medium">{plugin.name}</span>
            <TierBadge tier={plugin.tier} />
          </p>
          <p className="text-muted-foreground text-xs">
            {plugin.latest}
            {plugin.category ? ` · ${MARKET_CATEGORY_LABELS[plugin.category]}` : ''}
          </p>
        </div>
        <InstallAction plugin={plugin} disabled={disabled} onInstall={onInstall} />
      </div>
      {plugin.description && (
        <p className="line-clamp-2 text-muted-foreground text-xs">{plugin.description}</p>
      )}
    </div>
  );
}

function MarketDetail({
  plugin,
  disabled,
  onBack,
  onInstall,
}: {
  plugin: ExtensionPluginMarketEntry;
  disabled: boolean;
  onBack: () => void;
  onInstall: (id: string) => void;
}) {
  const { t } = useI18n();
  const homepage = httpHomepage(plugin.homepage);
  return (
    <div className="space-y-4">
      <Button size="xs" variant="ghost" onClick={onBack}>
        <ArrowLeft className="size-3.5" />
        返回
      </Button>
      <div className="flex items-start gap-3">
        <MarketIcon src={plugin.icon} large />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-base">{plugin.name}</span>
            <TierBadge tier={plugin.tier} />
            {plugin.category && (
              <Badge variant="outline" className="text-[11px]">
                {MARKET_CATEGORY_LABELS[plugin.category]}
              </Badge>
            )}
          </p>
          <p className="font-mono text-muted-foreground text-xs">
            {plugin.id} · {plugin.latest}
            {plugin.installedVersion ? ` · 已装 ${plugin.installedVersion}` : ''}
          </p>
          {plugin.description && <p className="text-sm">{plugin.description}</p>}
          {homepage && (
            <a
              href={homepage}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
            >
              <ExternalLink className="size-3" />
              {t('Homepage')}
            </a>
          )}
        </div>
        <InstallAction plugin={plugin} disabled={disabled} onInstall={onInstall} />
      </div>
      {plugin.screenshots && plugin.screenshots.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {plugin.screenshots.map((shot) => (
            <img
              key={shot.url}
              src={shot.url}
              alt={shot.alt}
              title={shot.alt}
              loading="lazy"
              className="h-44 shrink-0 rounded-md border object-cover"
            />
          ))}
        </div>
      )}
      <section className="space-y-1">
        <h3 className="font-medium text-sm">权限</h3>
        {plugin.permissions.length === 0 ? (
          <p className="text-muted-foreground text-xs">无特殊权限</p>
        ) : (
          <ul className="space-y-0.5">
            {plugin.permissions.map((perm) => (
              <li key={perm} className="text-xs">
                <span className="font-mono text-muted-foreground">{perm}</span>
                <span className="ml-2">{pluginPermissionLabel(perm)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-1">
        <h3 className="font-medium text-sm">{t('Usage guide')}</h3>
        <PluginReadmeBody
          pluginId={plugin.id}
          from="market"
          homepage={plugin.homepage}
          showLink={false}
        />
      </section>
    </div>
  );
}

function MarketIcon({ src, large }: { src?: string; large?: boolean }) {
  const [broken, setBroken] = React.useState(false);
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md bg-muted',
        large ? 'size-12' : 'size-9'
      )}
    >
      {src && !broken ? (
        <img
          src={src}
          alt=""
          className={large ? 'size-7 object-contain' : 'size-5 object-contain'}
          onError={() => setBroken(true)}
        />
      ) : (
        <Puzzle className="size-4 text-muted-foreground" />
      )}
    </div>
  );
}
