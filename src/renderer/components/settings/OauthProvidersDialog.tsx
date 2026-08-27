import type { OauthLoginEvent, OauthLoginPrompt, OauthProviderInfo } from '@shared/types';
import { CircleAlert, CircleCheck, ExternalLink, Loader2, LogIn, LogOut } from 'lucide-react';
import * as React from 'react';
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
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';

interface OauthProvidersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OauthProvidersDialog({ open, onOpenChange }: OauthProvidersDialogProps) {
  const { t } = useI18n();

  const [providers, setProviders] = React.useState<OauthProviderInfo[] | null>(null);
  /** 登录中的 providerId */
  const [busy, setBusy] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [authUrl, setAuthUrl] = React.useState<string | null>(null);
  const [userCode, setUserCode] = React.useState<string | null>(null);
  const [prompt, setPrompt] = React.useState<OauthLoginPrompt | null>(null);
  const [promptValue, setPromptValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setProviders(await window.electronAPI.providers.listOauth());
  }, []);

  React.useEffect(() => {
    if (open) {
      setProviders(null);
      setError(null);
      void refresh();
    }
  }, [open, refresh]);

  /** 登录成功后把订阅条目写入/刷新 settings（模型来自内置 catalog，新增默认启用） */
  const upsertProvider = React.useCallback((info: OauthProviderInfo) => {
    const store = useSettingsStore.getState();
    const existing = store.providers.find((p) => p.oauthProviderId === info.id);
    if (existing) {
      const known = new Set(existing.models.map((m) => m.id));
      const fresh = info.models.filter((id) => !known.has(id)).map((id) => ({ id, enabled: true }));
      if (fresh.length > 0) {
        store.updateProvider(existing.id, { models: [...existing.models, ...fresh] });
      }
      return;
    }
    store.addProviders([
      {
        id: crypto.randomUUID(),
        name: info.name,
        api: 'openai-completions',
        apiKey: '',
        baseUrl: '',
        enabled: true,
        models: info.models.map((id) => ({ id, enabled: true })),
        oauthProviderId: info.id,
      },
    ]);
  }, []);

  const resetFlow = React.useCallback(() => {
    setBusy(null);
    setProgress(null);
    setAuthUrl(null);
    setUserCode(null);
    setPrompt(null);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    return window.electronAPI.providers.onOauthLoginEvent((event: OauthLoginEvent) => {
      switch (event.type) {
        case 'info':
        case 'progress':
          setProgress(event.message);
          break;
        case 'auth_url':
          setAuthUrl(event.url);
          setProgress(event.instructions ?? t('Complete authorization in your browser'));
          break;
        case 'device_code':
          setAuthUrl(event.verificationUri);
          setUserCode(event.userCode);
          break;
        case 'prompt':
          setPrompt(event.prompt);
          setPromptValue('');
          break;
        case 'prompt-cancel':
          setPrompt((prev) => (prev?.requestId === event.requestId ? null : prev));
          break;
        case 'done': {
          const info = providers?.find((p) => p.id === event.providerId);
          if (info) upsertProvider(info);
          resetFlow();
          void refresh();
          break;
        }
        case 'error':
          setError(event.message);
          resetFlow();
          break;
      }
    });
  }, [open, providers, refresh, resetFlow, t, upsertProvider]);

  const handleLogin = (providerId: string) => {
    setError(null);
    setBusy(providerId);
    setProgress(t('Starting login...'));
    void window.electronAPI.providers.oauthLogin(providerId);
  };

  const handleCancel = () => {
    void window.electronAPI.providers.oauthLoginCancel();
    resetFlow();
  };

  const handleLogout = async (providerId: string) => {
    await window.electronAPI.providers.oauthLogout(providerId);
    await refresh();
  };

  const submitPrompt = () => {
    if (!prompt || !promptValue.trim()) return;
    void window.electronAPI.providers.oauthLoginRespond(prompt.requestId, promptValue.trim());
    setPrompt(null);
    setProgress(t('Verifying...'));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && busy === null && onOpenChange(false)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('Subscription login')}</DialogTitle>
          <DialogDescription>
            {t('Sign in with provider subscriptions (SuperGrok, Claude Pro, ChatGPT, etc.)')}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="max-h-[55vh] space-y-1">
          {providers === null && (
            <div className="flex justify-center py-10">
              <Spinner className="size-5" />
            </div>
          )}

          {providers?.map((provider) => (
            <div
              key={provider.id}
              className="flex items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent/50"
            >
              <div className="flex min-w-0 flex-col">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{provider.name}</span>
                  {provider.loggedIn && (
                    <Badge variant="secondary" className="shrink-0 gap-1 text-[11px]">
                      <CircleCheck className="h-3 w-3" />
                      {t('Logged in')}
                    </Badge>
                  )}
                </div>
                {provider.loginLabel && (
                  <span className="truncate text-xs text-muted-foreground">
                    {provider.loginLabel}
                  </span>
                )}
              </div>
              <div className="shrink-0">
                {provider.loggedIn ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => handleLogout(provider.id)}
                  >
                    <LogOut className="mr-1.5 h-3.5 w-3.5" />
                    {t('Log out')}
                  </Button>
                ) : busy === provider.id ? (
                  <Button variant="outline" size="sm" onClick={handleCancel}>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t('Cancel')}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => handleLogin(provider.id)}
                  >
                    <LogIn className="mr-1.5 h-3.5 w-3.5" />
                    {t('Log in')}
                  </Button>
                )}
              </div>
            </div>
          ))}

          {busy !== null && (
            <div className="mt-2 space-y-2 rounded-md border bg-accent/30 px-3 py-2.5">
              {progress && <p className="text-xs text-muted-foreground">{progress}</p>}
              {userCode && (
                <p className="text-sm">
                  {t('Enter code')}:{' '}
                  <span className="font-mono font-semibold tracking-wider">{userCode}</span>
                </p>
              )}
              {authUrl && (
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                  onClick={() => void window.open(authUrl)}
                >
                  <ExternalLink className="h-3 w-3" />
                  {t('Open authorization page')}
                </button>
              )}
              {prompt && (
                <div className="space-y-1.5">
                  <p className="text-xs">{prompt.message}</p>
                  {prompt.type === 'select' ? (
                    <div className="flex flex-wrap gap-1.5">
                      {prompt.options?.map((option) => (
                        <Button
                          key={option.id}
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            void window.electronAPI.providers.oauthLoginRespond(
                              prompt.requestId,
                              option.id
                            );
                            setPrompt(null);
                          }}
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Input
                        autoFocus
                        type={prompt.type === 'secret' ? 'password' : 'text'}
                        value={promptValue}
                        onChange={(e) => setPromptValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitPrompt();
                        }}
                        placeholder={prompt.placeholder}
                        className="h-8 font-mono text-xs"
                      />
                      <Button size="sm" disabled={!promptValue.trim()} onClick={submitPrompt}>
                        {t('Submit')}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="flex items-center gap-1.5 px-1 pt-2 text-xs text-destructive">
              <CircleAlert className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-all">{error}</span>
            </p>
          )}
        </DialogPanel>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => onOpenChange(false)}
          >
            {t('Done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
