import { isClassifierOnlyProvider, mergeProviderDefinitions } from '@shared/providerCatalog';
import type { OauthAccount, OauthProviderInfo } from '@shared/types';
import { ArrowLeft, BadgeCheck, KeyRound, Puzzle } from 'lucide-react';
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
import { resolveProviderLogo } from './providerLogos';
import { availableProviderSetupMethods, initialProviderApiValue } from './providerSetup';

interface ProviderSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type WizardStep = 'provider' | 'method' | 'oauth' | 'api-key';

const WIZARD_STEP_ORDER: Record<WizardStep, number> = {
  provider: 0,
  method: 1,
  oauth: 2,
  'api-key': 2,
};

export function ProviderSetupWizard({ open, onOpenChange }: ProviderSetupWizardProps) {
  const { t } = useI18n();
  const addProviders = useSettingsStore((state) => state.addProviders);
  const [{ step, previousStep, transitionStarted, pageId }, setWizardPage] = React.useState<{
    step: WizardStep;
    previousStep: WizardStep | null;
    transitionStarted: boolean;
    pageId: '1' | '2';
  }>({ step: 'provider', previousStep: null, transitionStarted: true, pageId: '1' });
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
    setWizardPage({
      step: 'provider',
      previousStep: null,
      transitionStarted: true,
      pageId: '1',
    });
    setSelectedId(null);
    setLoadError(null);
    void refreshOauthProviders();
  }, [open, refreshOauthProviders]);

  const setStep = React.useCallback((next: WizardStep) => {
    setWizardPage((current) =>
      current.step === next
        ? current
        : {
            step: next,
            previousStep: current.step,
            transitionStarted: false,
            pageId: WIZARD_STEP_ORDER[next] >= WIZARD_STEP_ORDER[current.step] ? '2' : '1',
          }
    );
  }, []);

  React.useLayoutEffect(() => {
    if (!previousStep || transitionStarted) return;
    const frame = window.requestAnimationFrame(() => {
      setWizardPage((current) =>
        current.step === step ? { ...current, transitionStarted: true } : current
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [previousStep, step, transitionStarted]);

  React.useEffect(() => {
    if (!previousStep || !transitionStarted) return;
    const styles = getComputedStyle(document.documentElement);
    const number = (name: string, fallback: number) => {
      const value = Number.parseFloat(styles.getPropertyValue(name));
      return Number.isFinite(value) ? value : fallback;
    };
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : Math.max(number('--page-slide-dur', 250), number('--page-fade-dur', 250)) +
        number('--page-stagger', 0);
    const timer = window.setTimeout(() => {
      setWizardPage((current) =>
        current.step === step
          ? { ...current, previousStep: null, transitionStarted: true }
          : current
      );
      if (step === 'provider') setSelectedId(null);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [previousStep, step, transitionStarted]);

  const upsertOauthAccount = React.useCallback((info: OauthProviderInfo, account: OauthAccount) => {
    const store = useSettingsStore.getState();
    const existing = store.providers.find(
      (provider) => provider.oauthAccountKey === account.key && !provider.oauthAccountPool
    );
    if (existing) {
      // 模型清单由统一模型目录实时派生，不再把登录时刻的清单冻结进 settings；
      // 已有条目保留稀疏覆盖表（禁用/别名/能力覆盖）原样。
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
        // 稀疏覆盖表起步为空：目录里的模型缺省全部启用
        models: [],
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
      setStep('provider');
    } else {
      setStep('method');
    }
  };

  const activePageId = pageId;
  const previousPageId: '1' | '2' = activePageId === '1' ? '2' : '1';
  const displayedPageId = previousStep && !transitionStarted ? previousPageId : activePageId;
  const renderedPages: Array<{ id: '1' | '2'; step: WizardStep }> = previousStep
    ? [
        { id: previousPageId, step: previousStep },
        { id: activePageId, step },
      ]
    : [{ id: activePageId, step }];

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

        <DialogPanel className="t-page-slide provider-setup-pages" data-page={displayedPageId}>
          {renderedPages.map((page) => (
            <section
              key={`${page.id}:${page.step}`}
              aria-hidden={page.step !== step}
              className="t-page flex min-h-0 flex-col"
              data-page-id={page.id}
              inert={page.step !== step ? true : undefined}
            >
              {page.step === 'provider' && (
                <DialogPanel bare className="space-y-2">
                  {loadError && (
                    <div className="flex items-start justify-between gap-3 rounded-md bg-destructive/5 px-3 py-2 text-destructive-text">
                      <div className="min-w-0">
                        <p className="text-xs font-medium">
                          {t('Could not load subscription providers')}
                        </p>
                        <p className="mt-0.5 break-words text-[11px] text-destructive-text/80">
                          {loadError}
                        </p>
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
                          className="flex min-w-0 items-center gap-3 rounded-md bg-muted/40 px-3 py-3 text-left transition-colors hover:bg-accent"
                          onClick={() => {
                            setSelectedId(definition.id);
                            setStep('method');
                          }}
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
                            <ProviderCatalogMark
                              id={definition.oauthProviderId ?? definition.id}
                              label={definition.label}
                            />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {t(definition.label)}
                            </span>
                            {isClassifierOnlyProvider({ catalogId: definition.id }) && (
                              <span className="block text-xs text-muted-foreground">
                                {t('Classification only, not for chat')}
                              </span>
                            )}
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

              {page.step === 'method' && selected && (
                <DialogPanel bare className="space-y-3">
                  <p className="text-sm font-medium">{t('Choose how to connect')}</p>
                  {isClassifierOnlyProvider({ catalogId: selected.id }) && (
                    <p className="text-xs text-muted-foreground">
                      {t('Classification only, not for chat')}
                    </p>
                  )}
                  {availableProviderSetupMethods(selected).includes('oauth') && (
                    <button
                      type="button"
                      className="flex w-full min-w-0 items-center gap-3 rounded-md bg-muted/40 px-4 py-3 text-left transition-colors hover:bg-accent"
                      onClick={() => setStep('oauth')}
                    >
                      <BadgeCheck className="h-5 w-5 shrink-0 text-primary" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">
                          {t('Provider subscription')}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t('Sign in in your browser and use your subscription account.')}
                        </span>
                      </span>
                    </button>
                  )}
                  {availableProviderSetupMethods(selected).includes('api-key') && (
                    <button
                      type="button"
                      className="flex w-full min-w-0 items-center gap-3 rounded-md bg-muted/40 px-4 py-3 text-left transition-colors hover:bg-accent"
                      onClick={() => setStep('api-key')}
                    >
                      <KeyRound className="h-5 w-5 shrink-0 text-primary" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{t('API Key')}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t('Configure an endpoint and key, then fetch or test its models.')}
                        </span>
                      </span>
                    </button>
                  )}
                </DialogPanel>
              )}

              {page.step === 'oauth' && selected && selectedOauth && (
                <DialogPanel bare className="space-y-4">
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
                      onImported={async (account) => {
                        const infos = await refreshOauthProviders();
                        const info = infos.find((provider) => provider.id === selectedOauth.id);
                        if (info) upsertOauthAccount(info, account);
                        await refreshOauthCredentialState();
                      }}
                    />
                  )}
                </DialogPanel>
              )}

              {page.step === 'api-key' && selected && (
                <ProviderApiForm
                  key={selected.id}
                  bare
                  catalogId={selected.id}
                  initialValue={initialProviderApiValue(selected)}
                  oauth={false}
                  onCancel={back}
                  onSave={(value, seenModelIds) => {
                    addProviders([
                      {
                        ...value,
                        knownModelIds: [...seenModelIds],
                        id: crypto.randomUUID(),
                        enabled: true,
                        catalogId: selected.id,
                      },
                    ]);
                    close();
                  }}
                />
              )}

              {(page.step === 'provider' ||
                page.step === 'method' ||
                (page.step === 'oauth' &&
                  flow.state.phase !== 'running' &&
                  flow.state.phase !== 'error')) && (
                <DialogFooter className="sm:justify-between">
                  {page.step === 'provider' ? (
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
            </section>
          ))}
        </DialogPanel>
      </DialogContent>
    </Dialog>
  );
}

function ProviderCatalogMark({ id, label }: { id: string; label: string }) {
  const logo = resolveProviderLogo(id, label);
  if (!logo) return <Puzzle className="h-4 w-4 text-muted-foreground" />;
  if (logo.kind === 'letter') {
    return <span className="text-xs font-semibold text-muted-foreground">{logo.letter}</span>;
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
      <path d={logo.path} />
    </svg>
  );
}
