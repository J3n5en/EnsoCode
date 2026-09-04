import { mergeProviderDefinitions } from '@shared/providerCatalog';
import type { OauthAccount, OauthProviderInfo } from '@shared/types';
import { ArrowLeft, BadgeCheck, KeyRound, Server } from 'lucide-react';
import * as React from 'react';
import { refreshOauthCredentialState } from '@/components/oauth/OauthCredentialBootstrap';
import { OauthLoginStep } from '@/components/oauth/OauthLoginStep';
import { useOauthLoginFlow } from '@/components/oauth/useOauthLoginFlow';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { autoProviderName, OauthProviderAccounts } from './OauthProvidersDialog';
import { ProviderApiForm } from './ProviderApiForm';
import { availableProviderSetupMethods, initialProviderApiValue } from './providerSetup';

interface ProviderSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type WizardStep = 'provider' | 'method' | 'oauth' | 'api-key';

export function ProviderSetupWizard({ open, onOpenChange }: ProviderSetupWizardProps) {
  const { t } = useI18n();
  const addProviders = useSettingsStore((state) => state.addProviders);
  const [step, setStep] = React.useState<WizardStep>('provider');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [oauthProviders, setOauthProviders] = React.useState<OauthProviderInfo[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const refreshOauthProviders = React.useCallback(async () => {
    try {
      const infos = await window.electronAPI.providers.listOauth();
      setOauthProviders(infos);
      setLoadError(null);
      return infos;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      return [];
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setStep('provider');
    setSelectedId(null);
    setLoadError(null);
    void refreshOauthProviders();
  }, [open, refreshOauthProviders]);

  const upsertOauthAccount = React.useCallback((info: OauthProviderInfo, account: OauthAccount) => {
    const store = useSettingsStore.getState();
    const existing = store.providers.find((provider) => provider.oauthAccountKey === account.key);
    if (existing) {
      const known = new Set(existing.models.map((model) => model.id));
      const fresh = info.models.filter((id) => !known.has(id)).map((id) => ({ id, enabled: true }));
      if (fresh.length > 0) {
        store.updateProvider(existing.id, { models: [...existing.models, ...fresh] });
      }
      return;
    }
    store.addProviders([
      {
        id: crypto.randomUUID(),
        name: autoProviderName(info.name, account),
        api: 'openai-completions',
        apiKey: '',
        baseUrl: '',
        enabled: true,
        models: info.models.map((id) => ({ id, enabled: true })),
        oauthAccountKey: account.key,
      },
    ]);
  }, []);

  const flow = useOauthLoginFlow({
    onDone: (providerId, account) => {
      void (async () => {
        const infos = await refreshOauthProviders();
        const info = infos.find((provider) => provider.id === providerId);
        if (info) upsertOauthAccount(info, account);
        await refreshOauthCredentialState();
        setStep('oauth');
      })();
    },
  });

  const definitions = React.useMemo(
    () => mergeProviderDefinitions(oauthProviders),
    [oauthProviders]
  );
  const selected = definitions.find((definition) => definition.id === selectedId) ?? null;
  const selectedOauth = selected?.oauthProviderId
    ? oauthProviders.find((provider) => provider.id === selected.oauthProviderId)
    : undefined;
  const flowActive = flow.state.phase === 'running';

  const close = () => {
    if (flowActive) return;
    flow.reset();
    onOpenChange(false);
  };

  const back = () => {
    flow.reset();
    if (step === 'method') {
      setSelectedId(null);
      setStep('provider');
    } else {
      setStep('method');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Add model or provider')}</DialogTitle>
          <DialogDescription>
            {step === 'provider'
              ? t('Choose a provider first. You will select subscription or API Key next.')
              : selected
                ? t(selected.label)
                : undefined}
          </DialogDescription>
        </DialogHeader>

        {step === 'provider' && (
          <DialogPanel className="max-h-[55vh] space-y-2">
            {loadError && (
              <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
                <div className="min-w-0">
                  <p className="text-xs font-medium">
                    {t('Could not load subscription providers')}
                  </p>
                  <p className="mt-0.5 break-words text-[11px] text-destructive/80">{loadError}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => void refreshOauthProviders()}
                >
                  {t('Retry')}
                </Button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {definitions.map((definition) => {
                const methods = availableProviderSetupMethods(definition);
                return (
                  <button
                    key={definition.id}
                    type="button"
                    className="flex min-w-0 items-center gap-3 rounded-md border px-3 py-3 text-left transition-colors hover:bg-accent"
                    onClick={() => {
                      setSelectedId(definition.id);
                      setStep('method');
                    }}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Server className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {t(definition.label)}
                      </span>
                      <span className="mt-1 flex flex-wrap gap-1">
                        {methods.includes('oauth') && (
                          <Badge variant="outline" className="text-[10px]">
                            {t('Subscription')}
                          </Badge>
                        )}
                        {methods.includes('api-key') && (
                          <Badge variant="outline" className="text-[10px]">
                            {t('API Key')}
                          </Badge>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </DialogPanel>
        )}

        {step === 'method' && selected && (
          <DialogPanel className="space-y-3">
            <p className="text-sm font-medium">{t('Choose how to connect')}</p>
            {availableProviderSetupMethods(selected).includes('oauth') && (
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-colors hover:bg-accent"
                onClick={() => setStep('oauth')}
              >
                <BadgeCheck className="h-5 w-5 shrink-0 text-primary" />
                <span>
                  <span className="block text-sm font-medium">{t('Provider subscription')}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t('Sign in in your browser and use your subscription account.')}
                  </span>
                </span>
              </button>
            )}
            {availableProviderSetupMethods(selected).includes('api-key') && (
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-colors hover:bg-accent"
                onClick={() => setStep('api-key')}
              >
                <KeyRound className="h-5 w-5 shrink-0 text-primary" />
                <span>
                  <span className="block text-sm font-medium">{t('API Key')}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t('Configure an endpoint and key, then fetch or test its models.')}
                  </span>
                </span>
              </button>
            )}
          </DialogPanel>
        )}

        {step === 'oauth' && selected && selectedOauth && (
          <DialogPanel className="space-y-4">
            {flow.state.phase === 'running' || flow.state.phase === 'error' ? (
              <OauthLoginStep flow={flow} providerLabel={t(selected.label)} onBack={back} />
            ) : (
              <OauthProviderAccounts
                provider={selectedOauth}
                loginBusy={flowActive}
                onStartLogin={() => flow.start(selectedOauth.id)}
                onChanged={async () => {
                  await refreshOauthCredentialState();
                  await refreshOauthProviders();
                }}
              />
            )}
          </DialogPanel>
        )}

        {step === 'api-key' && selected && (
          <ProviderApiForm
            key={selected.id}
            initialValue={initialProviderApiValue(selected)}
            oauth={false}
            onCancel={back}
            onSave={(value) => {
              addProviders([
                {
                  ...value,
                  id: crypto.randomUUID(),
                  enabled: true,
                  catalogId: selected.id,
                },
              ]);
              close();
            }}
          />
        )}

        {(step === 'provider' ||
          step === 'method' ||
          (step === 'oauth' && flow.state.phase !== 'running' && flow.state.phase !== 'error')) && (
          <DialogFooter className="sm:justify-between">
            {step === 'provider' ? (
              <span />
            ) : (
              <Button variant="outline" size="sm" onClick={back}>
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                {t('Back')}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={close}>
              {t('Done')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
