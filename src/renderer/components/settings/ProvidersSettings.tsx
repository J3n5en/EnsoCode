import { CUSTOM_VENDOR_ID, groupProviders } from '@shared/providerGroups';
import type { ModelProvider, OauthProviderInfo } from '@shared/types';
import {
  BadgeCheck,
  HardDriveDownload,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Server,
  Trash2,
} from 'lucide-react';
import * as React from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { refreshOauthCredentialState } from '@/components/oauth/OauthCredentialBootstrap';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useCachedAccountUsage } from '@/hooks/useAccountUsage';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';
import { ApprovalReviewerPicker } from './ApprovalReviewerPicker';
import { API_KIND_LABELS } from './constants';
import { DefaultModelPicker } from './DefaultModelPicker';
import { LocalImportDialog } from './LocalImportDialog';
import { AccountUsageBlock } from './OauthProvidersDialog';
import { ProviderEditDialog } from './ProviderEditDialog';
import { ProviderSetupWizard } from './ProviderSetupWizard';
import { SubagentModelsSettings } from './SubagentModelsSettings';
import { TitleSummaryPicker } from './TitleSummaryPicker';

/** 订阅行额度：按账号拉取（60s 共享缓存），复用向导里的展示块；拉取失败静默隐藏 */
function SubscriptionUsage({ accountKey }: { accountKey: string }) {
  const info = useCachedAccountUsage(accountKey);
  if (!info || info.error) return null;
  return <AccountUsageBlock info={info} />;
}

export function ProvidersSettings() {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const updateProvider = useSettingsStore((state) => state.updateProvider);
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
    if (provider.oauthAccountKey && !options?.skipLogout) {
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

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4" data-settings-row="providers.root">
        <div>
          <h3 className="text-lg font-medium">{t('Model Providers')}</h3>
          <p className="text-sm text-muted-foreground">
            {t('Manage model API providers for this app')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <HardDriveDownload className="h-4 w-4 mr-1.5" />
            {t('Import from local apps')}
          </Button>
          <Button size="sm" onClick={() => setSetupOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            {t('Add model or provider')}
          </Button>
        </div>
      </div>
      <DefaultModelPicker />
      <TitleSummaryPicker />
      <ApprovalReviewerPicker />
      <SubagentModelsSettings />

      {providers.length === 0 ? (
        <div className="rounded-md border border-dashed px-3 py-8 text-center">
          <Server className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">{t('No providers yet')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('Import providers from local apps or use the unified setup to get started')}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {groups.map((group) => {
            const oauthInfo = oauthInfos.find((info) => info.id === group.vendorId);
            const label = group.vendorId === CUSTOM_VENDOR_ID ? t('Custom') : group.label;
            return (
              <div key={group.vendorId} className="rounded-md px-3 py-2">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
                    {label}
                  </span>
                  <span className="text-[11px] text-muted-foreground/60">
                    {group.providers.length}
                  </span>
                </div>
                <div className="mt-1.5 space-y-1 border-l pl-3">
                  {group.providers.map((provider) => {
                    const isSubscription = Boolean(provider.oauthAccountKey);
                    const account = provider.oauthAccountKey
                      ? oauthInfo?.accounts.find((a) => a.key === provider.oauthAccountKey)
                      : undefined;
                    // 订阅行主位放账号身份（邮箱/账号 key），不是厂商名——厂商名已经是分组标题
                    const primaryLabel = isSubscription
                      ? (account?.email ?? provider.oauthAccountKey ?? provider.name)
                      : provider.name;
                    return (
                      <React.Fragment key={provider.id}>
                        <div
                          className="group flex items-start justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent/50"
                          data-settings-row={`providers.${provider.id}`}
                        >
                          <div className="min-w-0 flex-1 overflow-hidden">
                            <div className="flex min-w-0 items-center gap-2">
                              {isSubscription ? (
                                <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              ) : (
                                <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              )}
                              <span
                                className={cn(
                                  'truncate text-sm font-medium',
                                  !provider.enabled && 'text-muted-foreground line-through'
                                )}
                              >
                                {primaryLabel}
                              </span>
                              {isSubscription ? (
                                account?.plan && (
                                  <Badge
                                    variant="outline"
                                    className="shrink-0 text-[10px] uppercase"
                                  >
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
                              <span className="min-w-0 truncate text-xs text-muted-foreground">
                                {[
                                  isSubscription ? undefined : provider.baseUrl,
                                  provider.models.length > 0
                                    ? t('{{count}} models', { count: provider.models.length })
                                    : undefined,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </span>
                            </div>
                            {provider.oauthAccountKey && (
                              <SubscriptionUsage accountKey={provider.oauthAccountKey} />
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-1 pt-0.5">
                            <Switch
                              checked={provider.enabled}
                              onCheckedChange={(enabled) =>
                                updateProvider(provider.id, { enabled })
                              }
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                              onClick={() => setEditing(provider)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={removingId === provider.id}
                              className={cn(
                                'h-7 w-7 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100',
                                removingId === provider.id && 'opacity-100'
                              )}
                              onClick={() => setPendingRemove(provider)}
                            >
                              {removingId === provider.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </div>
                        </div>
                        {removeError?.providerId === provider.id && (
                          <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
                            <span className="min-w-0 truncate">
                              {t('Sign-out failed: {{message}}', { message: removeError.message })}
                            </span>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 px-2 text-[11px]"
                                onClick={() => void performRemove(provider)}
                              >
                                {t('Retry')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-[11px] text-destructive hover:text-destructive"
                                onClick={() => void performRemove(provider, { skipLogout: true })}
                              >
                                {t('Delete anyway')}
                              </Button>
                            </div>
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

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
            ? pendingRemove.oauthAccountKey
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
    </div>
  );
}
