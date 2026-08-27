import type {
  OauthAccount,
  OauthAccountUsage,
  OauthLoginEvent,
  OauthLoginPrompt,
  OauthProviderInfo,
} from '@shared/types';
import { CircleAlert, ExternalLink, Loader2, LogOut, Plus } from 'lucide-react';
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

/**
 * 订阅条目在 settings 里的自动生成名：带上账号标识，让 ModelPicker 的分组标题能区分同厂商的多个账号。
 * 优先邮箱；邮箱未到时退回合成 key。首个账号的 key 就是裸 providerId，没有额外信息可标注。
 */
const autoProviderName = (providerName: string, account: OauthAccount): string => {
  const label = account.email ?? (account.key === account.providerId ? null : account.key);
  return label ? `${providerName} (${label})` : providerName;
};

export function OauthProvidersDialog({ open, onOpenChange }: OauthProvidersDialogProps) {
  const { t } = useI18n();

  const [providers, setProviders] = React.useState<OauthProviderInfo[] | null>(null);
  /** 正在登录的 providerId。Main 侧同一时刻只允许一个登录流，故是单值而非集合 */
  const [busy, setBusy] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [authUrl, setAuthUrl] = React.useState<string | null>(null);
  const [userCode, setUserCode] = React.useState<string | null>(null);
  const [prompt, setPrompt] = React.useState<OauthLoginPrompt | null>(null);
  const [promptValue, setPromptValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  /** 账号 key → 额度详情（best-effort，缺数据的不展示） */
  const [usage, setUsage] = React.useState<Record<string, OauthAccountUsage>>({});

  const refresh = React.useCallback(async () => {
    setProviders(await window.electronAPI.providers.listOauth());
  }, []);

  // 逐账号并发拉取额度（列表变化时只补拉缺失项）。
  // Main 侧的 email/plan 是 best-effort 缓存：anthropic/xai 要等这一次拉取才落盘，
  // 所以对还没有 email 的账号，拉完后重取一次列表把身份信息补上。
  React.useEffect(() => {
    if (!providers) return;
    for (const provider of providers) {
      for (const account of provider.accounts) {
        if (usage[account.key]) continue;
        void window.electronAPI.providers.oauthAccountUsage(account.key).then((info) => {
          setUsage((prev) => ({ ...prev, [account.key]: info }));
          if (!account.email) void refresh();
        });
      }
    }
  }, [providers, usage, refresh]);

  // email 晚到时，把仍是自动生成名的订阅条目改成带邮箱的名字；用户手动改过名的不动
  React.useEffect(() => {
    if (!providers) return;
    const store = useSettingsStore.getState();
    for (const provider of providers) {
      for (const account of provider.accounts) {
        if (!account.email) continue;
        const entry = store.providers.find((p) => p.oauthAccountKey === account.key);
        if (!entry) continue;
        const withEmail = autoProviderName(provider.name, account);
        if (entry.name !== autoProviderName(provider.name, { ...account, email: undefined })) {
          continue;
        }
        store.updateProvider(entry.id, { name: withEmail });
      }
    }
  }, [providers]);

  React.useEffect(() => {
    if (open) {
      setProviders(null);
      setError(null);
      setUsage({});
      void refresh();
    }
  }, [open, refresh]);

  /**
   * 登录成功后把该账号写入/刷新 settings。
   * 去重键是 `oauthAccountKey`（不是 providerId）——同一厂商可以有多条订阅条目。
   */
  const upsertProvider = React.useCallback((info: OauthProviderInfo, account: OauthAccount) => {
    const store = useSettingsStore.getState();
    const existing = store.providers.find((p) => p.oauthAccountKey === account.key);
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
          if (info) upsertProvider(info, event.account);
          // 清掉这个账号的额度缓存，触发重拉
          setUsage((prev) => {
            const next = { ...prev };
            delete next[event.account.key];
            return next;
          });
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

  /** 登录总是新增一个账号，已有账号不会被覆盖 */
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

  const handleLogout = async (accountKey: string) => {
    await window.electronAPI.providers.oauthLogout(accountKey);
    setUsage((prev) => {
      const next = { ...prev };
      delete next[accountKey];
      return next;
    });
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
            <div key={provider.id} className="rounded-md px-3 py-2 transition-colors">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{provider.name}</span>
                    {provider.accounts.length > 0 && (
                      <Badge variant="secondary" className="shrink-0 text-[11px]">
                        {t('{{count}} accounts', { count: provider.accounts.length })}
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
                  {busy === provider.id ? (
                    <Button variant="outline" size="sm" onClick={handleCancel}>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      {t('Cancel')}
                    </Button>
                  ) : provider.supportsMultipleAccounts || provider.accounts.length === 0 ? (
                    <Button
                      variant="outline"
                      size="sm"
                      // 主进程同一时刻只跑一个登录流，别的 provider 在登录时全部禁用
                      disabled={busy !== null}
                      onClick={() => handleLogin(provider.id)}
                    >
                      <Plus className="mr-1.5 h-3.5 w-3.5" />
                      {t('Add account')}
                    </Button>
                  ) : null}
                </div>
              </div>

              {provider.accounts.length > 0 && (
                <div className="mt-1.5 space-y-1 border-l pl-3">
                  {provider.accounts.map((account) => (
                    <div
                      key={account.key}
                      className="flex items-start justify-between gap-3 rounded-md px-1.5 py-1 transition-colors hover:bg-accent/50"
                    >
                      <div className="flex min-w-0 flex-col">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-xs font-medium">
                            {account.email ?? account.key}
                          </span>
                          {account.plan && (
                            <Badge variant="outline" className="shrink-0 text-[10px]">
                              {account.plan}
                            </Badge>
                          )}
                        </div>
                        <AccountUsageBlock info={usage[account.key]} />
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => handleLogout(account.key)}
                      >
                        <LogOut className="mr-1.5 h-3.5 w-3.5" />
                        {t('Log out')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
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
                  onClick={() => void window.electronAPI.providers.oauthLoginReopen()}
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

/** 单个账号的额度窗口。info 未到达即不渲染；拉取失败显示原因而不是留白 */
function AccountUsageBlock({ info }: { info: OauthAccountUsage | undefined }) {
  const { t } = useI18n();
  if (!info) return null;
  if (info.error) {
    return <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">{info.error}</p>;
  }
  if (info.windows.length === 0) return null;

  const resetLabel = (resetsAt?: number) => {
    if (!resetsAt) return null;
    return t('resets {{time}}', {
      time: new Date(resetsAt).toLocaleString(undefined, {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    });
  };

  return (
    <div className="mt-1 space-y-1">
      {info.windows.map((window) => (
        <div key={window.label} className="flex items-center gap-2 text-[11px]">
          <span className="w-6 shrink-0 font-mono text-muted-foreground">{window.label}</span>
          <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
            <div
              className={
                window.usedPercent >= 85
                  ? 'h-full bg-destructive'
                  : window.usedPercent >= 50
                    ? 'h-full bg-amber-500'
                    : 'h-full bg-emerald-500'
              }
              style={{ width: `${window.usedPercent}%` }}
            />
          </div>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {Math.round(window.usedPercent)}%
          </span>
          {window.resetsAt && (
            <span className="truncate text-muted-foreground/70">{resetLabel(window.resetsAt)}</span>
          )}
        </div>
      ))}
    </div>
  );
}
