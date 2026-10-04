import type { ModelProvider, OauthProviderInfo } from '@shared/types';
import { useEffect, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { useI18n } from '@/i18n';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';
import { chatgptPoolSources, providerDisplayName } from './chatgptPool';
import { ProviderApiForm } from './ProviderApiForm';

function PoolProviderForm({ provider, onClose }: { provider: ModelProvider; onClose: () => void }) {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const updateProvider = useSettingsStore((state) => state.updateProvider);
  const availability = useOauthCredentialStore((state) => state.snapshot.availability);
  const oauthRevision = useOauthCredentialStore((state) => state.snapshot.revision);
  const [oauthInfos, setOauthInfos] = useState<OauthProviderInfo[]>([]);
  const [selected, setSelected] = useState(provider.oauthAccountPool?.accountKeys ?? []);
  /**
   * 与普通账号列表一样，凭证 revision 变化时重拉展示元数据；关闭或新请求取代旧请求后忽略晚到响应。
   *
   * Like the regular account list, reload display metadata on credential revision changes; ignore late replies after closing or replacing a request.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision 是凭证变化后的刷新信号 / revision signals credential changes.
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.providers
      .listOauth()
      .then((infos) => {
        if (!cancelled) setOauthInfos(infos);
      })
      .catch((error) => {
        if (cancelled) return;
        setOauthInfos([]);
        console.error('Failed to load OAuth account metadata', error);
      });
    return () => {
      cancelled = true;
    };
  }, [oauthRevision]);
  const sources = chatgptPoolSources(providers);
  const keys = [
    ...sources.flatMap((source) => source.oauthAccountKey ?? []),
    ...selected.filter((key) => !sources.some((source) => source.oauthAccountKey === key)),
  ];
  return (
    <ProviderApiForm
      initialValue={{ ...provider, name: providerDisplayName(provider, t) }}
      oauth
      hideName
      saveDisabled={selected.length === 0}
      oauthAccountKey={provider.oauthAccountKey}
      onCancel={onClose}
      extraFields={
        <Field>
          <FieldLabel>{t('Pool members')}</FieldLabel>
          <p className="text-xs text-muted-foreground">
            {t(
              'Use enabled, signed-in accounts in the listed order. Model and reasoning stay unchanged. Main agents and subagents share this pool.'
            )}
          </p>
          <div className="mt-2 w-full space-y-1 rounded-md border p-1">
            {keys.map((key, index) => {
              const source = sources.find((item) => item.oauthAccountKey === key);
              const account = oauthInfos
                .flatMap((info) => info.accounts)
                .find((item) => item.key === key);
              return (
                <label key={key} className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm">
                  <Checkbox
                    checked={selected.includes(key)}
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked ? [...current, key] : current.filter((item) => item !== key)
                      )
                    }
                  />
                  <span className="shrink-0 text-xs text-muted-foreground">{index + 1}.</span>
                  <span className="min-w-0 truncate">{account?.email ?? key}</span>
                  {!source?.enabled && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t('Account disabled')}
                    </span>
                  )}
                  {availability.status === 'ready' &&
                    !availability.authenticatedAccountKeys.has(key) && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t('Account signed out')}
                      </span>
                    )}
                </label>
              );
            })}
          </div>
        </Field>
      }
      onSave={(value) => {
        if (selected.length === 0) return;
        updateProvider(provider.id, {
          models: value.models,
          oauthAccountPool: { accountKeys: keys.filter((key) => selected.includes(key)) },
        });
        onClose();
      }}
    />
  );
}

interface ProviderEditDialogProps {
  provider: ModelProvider | null;
  onClose: () => void;
}

/** 只编辑已存在条目；所有新建路径统一进入 ProviderSetupWizard。 */
export function ProviderEditDialog({ provider, onClose }: ProviderEditDialogProps) {
  const { t } = useI18n();
  const updateProvider = useSettingsStore((state) => state.updateProvider);

  return (
    <Dialog open={provider !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {provider?.oauthAccountPool ? providerDisplayName(provider, t) : t('Edit Provider')}
          </DialogTitle>
        </DialogHeader>
        {provider?.oauthAccountPool ? (
          <PoolProviderForm key={provider.id} provider={provider} onClose={onClose} />
        ) : (
          provider && (
            <ProviderApiForm
              key={provider.id}
              initialValue={{
                name: provider.name,
                api: provider.api,
                apiKey: provider.apiKey,
                baseUrl: provider.baseUrl,
                models: provider.models,
              }}
              oauth={Boolean(provider.oauthAccountKey)}
              oauthAccountKey={provider.oauthAccountKey}
              onCancel={onClose}
              onSave={(value) => {
                updateProvider(
                  provider.id,
                  provider.oauthAccountKey ? { name: value.name, models: value.models } : value
                );
                onClose();
              }}
            />
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
