import { isClassifierOnlyProvider } from '@shared/providerCatalog';
import { CUSTOM_VENDOR_ID, groupProviders } from '@shared/providerGroups';
import type { ModelProvider, OauthProviderInfo } from '@shared/types';
import {
  BadgeCheck,
  HardDriveDownload,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react';
import * as React from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { refreshOauthCredentialState } from '@/components/oauth/OauthCredentialBootstrap';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { addToast } from '@/components/ui/toast';
import { useCachedAccountUsage } from '@/hooks/useAccountUsage';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useMaterializedProviders } from '@/stores/modelDirectory/useProviders';
import { invalidateModelMeta } from '@/stores/modelMeta';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';
import { ApprovalReviewerPicker } from './ApprovalReviewerPicker';
import { chatgptPoolSources, createChatgptPoolProvider, providerDisplayName } from './chatgptPool';
import { API_KIND_LABELS } from './constants';
import { DefaultModelPicker } from './DefaultModelPicker';
import { GitCommitSettings } from './GitCommitSettings';
import { ImageGenerationPicker } from './ImageGenerationPicker';
import {
  SettingsButton,
  SettingsEmptyState,
  SettingsExpandableRow,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSubRow,
  SettingsSwitch,
} from './kit';
import { LocalImportDialog } from './LocalImportDialog';
import { NewSessionBadge } from './NewSessionBadge';
import { AccountUsageBlock } from './OauthProvidersDialog';
import { ProviderEditDialog } from './ProviderEditDialog';
import { ProviderSetupWizard } from './ProviderSetupWizard';
import {
  applyFetchedModels,
  fetchAllProviderModels,
  type ProviderFetchOutcome,
  refreshProvider,
  useProviderFetchState,
} from './providerFetch';
import { ProviderGroupLabel } from './providerGroupLabel';
import { SubagentModelsSettings } from './SubagentModelsSettings';
import { TitleSummaryPicker } from './TitleSummaryPicker';
import { VirtualModelsSettings } from './VirtualModelsSettings';

/** 订阅行额度：按账号拉取（60s 共享缓存），复用向导里的展示块；拉取失败静默隐藏 */
function SubscriptionUsage({ accountKey }: { accountKey: string }) {
  const info = useCachedAccountUsage(accountKey);
  if (!info || info.error) return null;
  return <AccountUsageBlock info={info} />;
}

function ProviderRefreshButton({
  provider,
  onStart,
}: {
  provider: ModelProvider;
  onStart: () => void;
}) {
  const { t } = useI18n();
  const updateProvider = useSettingsStore((state) => state.updateProvider);
  const { refreshing, error } = useProviderFetchState([provider.id]);
  const title = error ? `${t('Refresh failed')}: ${error}` : t('Refresh provider models');
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn('text-muted-foreground', error && 'text-destructive')}
      disabled={refreshing}
      aria-label={t('Refresh provider models')}
      title={title}
      data-provider-refresh={provider.id}
      onClick={() => {
        onStart();
        void refreshProvider(provider, updateProvider);
      }}
    >
      {refreshing ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <RefreshCw className={cn('h-3.5 w-3.5', error && 'text-destructive')} />
      )}
    </Button>
  );
}

function ProviderFetchFailure({
  providerId,
  fetchOutcome,
}: {
  providerId: string;
  fetchOutcome: ProviderFetchOutcome | undefined;
}) {
  const { t } = useI18n();
  const { error } = useProviderFetchState([providerId]);
  const message = error ?? (fetchOutcome?.status === 'failed' ? fetchOutcome.message : null);
  if (!message) return null;
  return (
    <p
      role="status"
      className="py-2.5 pl-10 pr-4 text-destructive-text text-xs max-sm:pl-7 max-sm:pr-3"
    >
      {t('Fetch failed')}: {message}
    </p>
  );
}

export function ProvidersSettings() {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const materializedProviders = useMaterializedProviders();
  const updateProvider = useSettingsStore((state) => state.updateProvider);
  const addProviders = useSettingsStore((state) => state.addProviders);
  const removeProvider = useSettingsStore((state) => state.removeProvider);
  const [importOpen, setImportOpen] = React.useState(false);
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ModelProvider | null>(null);
  const [pendingRemove, setPendingRemove] = React.useState<ModelProvider | null>(null);
  const [removingId, setRemovingId] = React.useState<string | null>(null);
  const [removeError, setRemoveError] = React.useState<{
    providerId: string;
    message: string;
  } | null>(null);
  const [fetching, setFetching] = React.useState(false);
  const [catalogRefreshing, setCatalogRefreshing] = React.useState(false);
  const [fetchOutcomes, setFetchOutcomes] = React.useState<Record<
    string,
    ProviderFetchOutcome
  > | null>(null);

  /** 账号展示跟随非持久凭证快照 revision；跨窗口 invalidation 后会自动重拉。 */
  const oauthRevision = useOauthCredentialStore((state) => state.snapshot.revision);
  const [oauthInfos, setOauthInfos] = React.useState<OauthProviderInfo[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision 是跨窗口凭证变化后的显式重拉信号。
  React.useEffect(() => {
    let cancelled = false;
    void window.electronAPI.providers.listOauth().then((infos) => {
      if (!cancelled) setOauthInfos(infos);
    });
    return () => {
      cancelled = true;
    };
  }, [oauthRevision]);

  const groups = React.useMemo(
    () => groupProviders(providers, oauthInfos),
    [providers, oauthInfos]
  );
  const modelCountById = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of materializedProviders) counts.set(entry.id, entry.models.length);
    return counts;
  }, [materializedProviders]);

  /**
   * 删除订阅条目时联动退登（凭证与条目一体，否则订阅登录仍显示已登录）。
   * 退登粒度是账号 key 而非基础 providerId——同一厂商的其他账号不该被连带登出。
   * 取消不产生任何副作用：只有确认按钮会触发 performRemove。
   *
   * ⚠️ 这里曾经是「退登失败不阻塞条目删除」（fire-and-forget + 空 catch 吞异常，登出失败也照删）。
   * 现在反过来：先 await oauthLogout 成功再 removeProvider；失败则保留条目、展示可重试的错误、
   * 并给一个「仍要删除本地配置」的逃生口。原因：旧写法会让敏感凭证残留在磁盘，UI 却已经看不到
   * 这个条目、用户没有任何入口能再触发一次退登——残留凭证的代价比「网络抖动时多等一下」高得多。
   * accountKey 若本来就不在 auth.json 里（本来没登录 / 已被外部工具删掉），oauthLogout 对不存在
   * 的键是 no-op（main 侧 oauthLogout 里 hasStoredAccount 未命中直接 return），会正常 resolve
   * 直接往下走，不会卡在这——真正会走进下面 catch、需要重试或「仍要删除」的只有磁盘写入类真失败。
   */
  const performRemove = async (provider: ModelProvider, options?: { skipLogout?: boolean }) => {
    setRemovingId(provider.id);
    setRemoveError(null);
    if (provider.oauthAccountKey && !provider.oauthAccountPool && !options?.skipLogout) {
      try {
        await window.electronAPI.providers.oauthLogout(provider.oauthAccountKey);
        await refreshOauthCredentialState();
      } catch (error) {
        setRemovingId(null);
        setRemoveError({
          providerId: provider.id,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    removeProvider(provider.id);
    setRemovingId(null);
    setRemoveError(null);
  };

  const confirmRemove = () => {
    const provider = pendingRemove;
    if (!provider) return;
    void performRemove(provider);
  };

  const fetchAllModels = async () => {
    setFetching(true);
    setFetchOutcomes(null);
    try {
      const outcomes = await fetchAllProviderModels(providers);
      applyFetchedModels(outcomes, updateProvider);
      setFetchOutcomes(outcomes);
      const failed = Object.values(outcomes).filter((outcome) => outcome.status === 'failed');
      const ok = Object.keys(outcomes).length - failed.length;
      addToast({
        type: failed.length > 0 ? 'warning' : 'success',
        title: t('Fetched {{count}} providers', { count: ok }),
        ...(failed.length > 0
          ? { description: t('{{count}} failed', { count: failed.length }) }
          : {}),
      });
    } finally {
      setFetching(false);
    }
  };

  const refreshCatalog = async () => {
    setCatalogRefreshing(true);
    try {
      const result = await window.electronAPI.providers.refreshModelCatalog();
      invalidateModelMeta();
      addToast({
        type: result.ok ? 'success' : 'warning',
        title: result.ok
          ? t('Model info updated')
          : result.fromCache
            ? t('Model info refresh failed, using cache')
            : t('Model info refresh failed'),
      });
    } catch {
      addToast({ type: 'error', title: t('Model info refresh failed') });
    } finally {
      setCatalogRefreshing(false);
    }
  };

  const poolSources = chatgptPoolSources(providers);

  return (
    <SettingsPage
      rowId="providers.root"
      title={
        <>
          {t('Model Providers')}
          <NewSessionBadge
            note={t(
              'Newly enabled models can be picked right away. After changing a key or address, an open session uses it once you switch its model or start a new session.'
            )}
          />
        </>
      }
      description={t('Manage model API providers for this app')}
      actions={
        <>
          <SettingsButton disabled={catalogRefreshing} onClick={() => void refreshCatalog()}>
            {catalogRefreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t('Refresh model info')}
          </SettingsButton>
          <SettingsButton
            disabled={fetching || providers.length === 0}
            onClick={() => void fetchAllModels()}
          >
            {fetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t('Fetch all models')}
          </SettingsButton>
          <SettingsButton onClick={() => setImportOpen(true)}>
            <HardDriveDownload className="h-4 w-4" />
            {t('Import from local apps')}
          </SettingsButton>
          <SettingsButton variant="default" onClick={() => setSetupOpen(true)}>
            <Plus className="h-4 w-4" />
            {t('Add model or provider')}
          </SettingsButton>
        </>
      }
    >
      <SettingsSection
        rowId="providers.models-used-by-features"
        title={t('Models used by features')}
      >
        <DefaultModelPicker />
        <ImageGenerationPicker />
        <TitleSummaryPicker />
        <ApprovalReviewerPicker />
      </SettingsSection>
      <GitCommitSettings />
      <VirtualModelsSettings />
      <SubagentModelsSettings />

      <SettingsSection rowId="providers.providers" title={t('Providers')}>
        {poolSources.length > 0 && !providers.some((p) => p.oauthAccountPool) && (
          <SettingsRow
            rowId="providers.create-chatgpt-account-pool"
            label={t('Create ChatGPT account pool')}
            description={t(
              'Pool entries do not show a single account quota. Fixed-account entries remain unchanged.'
            )}
          >
            <SettingsButton
              onClick={() => {
                const pool = createChatgptPoolProvider(providers, crypto.randomUUID());
                if (pool && addProviders([pool]) > 0) setEditing(pool);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('Create')}
            </SettingsButton>
          </SettingsRow>
        )}
        {providers.length === 0 ? (
          <SettingsEmptyState
            icon={Server}
            title={t('No providers yet')}
            description={t(
              'Import providers from local apps or use the unified setup to get started'
            )}
            actions={
              <>
                <SettingsButton variant="default" onClick={() => setSetupOpen(true)}>
                  <Plus className="h-4 w-4" />
                  {t('Add model or provider')}
                </SettingsButton>
                <SettingsButton onClick={() => setImportOpen(true)}>
                  <HardDriveDownload className="h-4 w-4" />
                  {t('Import from local apps')}
                </SettingsButton>
              </>
            }
          />
        ) : (
          groups.map((group) => {
            const oauthInfo = oauthInfos.find((info) => info.id === group.vendorId);
            const label = group.vendorId === CUSTOM_VENDOR_ID ? t('Custom') : group.label;
            return (
              <SettingsExpandableRow
                key={group.vendorId}
                defaultOpen
                label={<ProviderGroupLabel label={label} count={group.providers.length} />}
              >
                {group.providers.map((provider) => {
                  const isSubscription = Boolean(provider.oauthAccountKey);
                  const modelCount = modelCountById.get(provider.id) ?? provider.models.length;
                  const account =
                    provider.oauthAccountKey && !provider.oauthAccountPool
                      ? oauthInfo?.accounts.find((a) => a.key === provider.oauthAccountKey)
                      : undefined;
                  // 订阅行主位放账号身份（邮箱/账号 key），不是厂商名——厂商名已经是分组标题
                  const primaryLabel = provider.oauthAccountPool
                    ? providerDisplayName(provider, t)
                    : isSubscription
                      ? (account?.email ?? provider.oauthAccountKey ?? provider.name)
                      : provider.name;
                  const fetchOutcome = fetchOutcomes?.[provider.id];
                  const meta = [
                    isSubscription ? undefined : provider.baseUrl,
                    provider.oauthAccountPool
                      ? t('{{count}} accounts', {
                          count: provider.oauthAccountPool.accountKeys.length,
                        })
                      : undefined,
                    modelCount > 0 ? t('{{count}} models', { count: modelCount }) : undefined,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <React.Fragment key={provider.id}>
                      <SettingsSubRow
                        rowId={`providers.${provider.id}`}
                        label={
                          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            {isSubscription ? (
                              <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <span
                              className={cn(
                                'min-w-0 truncate font-medium',
                                !provider.enabled && 'text-muted-foreground line-through'
                              )}
                            >
                              {primaryLabel}
                            </span>
                            {isSubscription ? (
                              account?.plan && (
                                <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
                                  {account.plan}
                                </Badge>
                              )
                            ) : (
                              <Badge variant="outline" className="shrink-0 text-[11px]">
                                {API_KIND_LABELS[provider.api] ?? provider.api}
                              </Badge>
                            )}
                            {provider.importedFrom && (
                              <Badge variant="secondary" className="shrink-0 text-[11px]">
                                {provider.importedFrom}
                              </Badge>
                            )}
                          </span>
                        }
                        description={
                          <>
                            {meta && <span className="block break-all">{meta}</span>}
                            {isClassifierOnlyProvider(provider) && (
                              <span className="block">
                                {t('Classification only, not for chat')}
                              </span>
                            )}
                            {provider.oauthAccountKey && !provider.oauthAccountPool && (
                              <SubscriptionUsage accountKey={provider.oauthAccountKey} />
                            )}
                          </>
                        }
                      >
                        <ProviderRefreshButton
                          provider={provider}
                          onStart={() =>
                            setFetchOutcomes((current) => {
                              if (!current || !(provider.id in current)) return current;
                              const next = { ...current };
                              delete next[provider.id];
                              return next;
                            })
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground"
                          aria-label={t('Edit Provider')}
                          onClick={() => setEditing(provider)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={removingId === provider.id}
                          aria-label={t('Remove')}
                          className={cn('text-muted-foreground hover:text-destructive')}
                          onClick={() => setPendingRemove(provider)}
                        >
                          {removingId === provider.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <SettingsSwitch
                          checked={provider.enabled}
                          onCheckedChange={(enabled) => updateProvider(provider.id, { enabled })}
                        />
                      </SettingsSubRow>
                      {removeError?.providerId === provider.id && (
                        <SettingsSubRow
                          rowId="providers.sign-out-failed-message"
                          label={
                            <span className="text-destructive-text">
                              {t('Sign-out failed: {{message}}', { message: removeError.message })}
                            </span>
                          }
                        >
                          <SettingsButton onClick={() => void performRemove(provider)}>
                            {t('Retry')}
                          </SettingsButton>
                          <SettingsButton
                            variant="ghost"
                            className="text-destructive-text"
                            onClick={() => void performRemove(provider, { skipLogout: true })}
                          >
                            {t('Delete anyway')}
                          </SettingsButton>
                        </SettingsSubRow>
                      )}
                      <ProviderFetchFailure providerId={provider.id} fetchOutcome={fetchOutcome} />
                    </React.Fragment>
                  );
                })}
              </SettingsExpandableRow>
            );
          })
        )}
      </SettingsSection>

      <LocalImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <ProviderSetupWizard open={setupOpen} onOpenChange={setSetupOpen} />
      <ProviderEditDialog provider={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title={t('Remove provider?')}
        description={
          pendingRemove
            ? pendingRemove.oauthAccountKey && !pendingRemove.oauthAccountPool
              ? t(
                  'Removing this also signs out {{name}}. Other accounts for the same vendor stay signed in.',
                  { name: pendingRemove.name }
                )
              : t('This permanently deletes the "{{name}}" provider configuration.', {
                  name: pendingRemove.name,
                })
            : undefined
        }
        confirmLabel={t('Remove')}
        onConfirm={confirmRemove}
      />
    </SettingsPage>
  );
}
