import type { OauthAccount, OauthAccountUsage, OauthProviderInfo } from '@shared/types';
import { CircleAlert, Loader2, LogOut, Plus } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

export const autoProviderName = (providerName: string, account: OauthAccount): string => {
  const label = account.email ?? (account.key === account.providerId ? null : account.key);
  return label ? `${providerName} (${label})` : providerName;
};

interface OauthProviderAccountsProps {
  provider: OauthProviderInfo;
  loginBusy: boolean;
  onStartLogin: () => void;
  onChanged: () => Promise<void>;
}

/** 统一向导订阅分支里的账号详情；授权状态本身由 OauthLoginStep 单独承载。 */
export function OauthProviderAccounts({
  provider,
  loginBusy,
  onStartLogin,
  onChanged,
}: OauthProviderAccountsProps) {
  const { t } = useI18n();
  const [usage, setUsage] = React.useState<Record<string, OauthAccountUsage>>({});
  const [loggingOut, setLoggingOut] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    for (const account of provider.accounts) {
      if (usage[account.key]) continue;
      void window.electronAPI.providers.oauthAccountUsage(account.key).then((info) => {
        if (cancelled) return;
        setUsage((current) => ({ ...current, [account.key]: info }));
        if (!account.email) void onChanged();
      });
    }
    return () => {
      cancelled = true;
    };
  }, [onChanged, provider.accounts, usage]);

  const handleLogout = async (accountKey: string) => {
    setLoggingOut(accountKey);
    setError(null);
    try {
      await window.electronAPI.providers.oauthLogout(accountKey);
      setUsage((current) => {
        const next = { ...current };
        delete next[accountKey];
        return next;
      });
      await onChanged();
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : String(logoutError));
    } finally {
      setLoggingOut(null);
    }
  };

  const canAddAccount = provider.accounts.length === 0 || provider.supportsMultipleAccounts;

  return (
    <div className="space-y-4">
      {provider.accounts.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center">
          <p className="text-sm font-medium">{t('No subscription account connected')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('Authorize this provider to add its available models.')}
          </p>
        </div>
      ) : (
        <div className="space-y-1 rounded-md border p-1">
          {provider.accounts.map((account) => (
            <div
              key={account.key}
              className="flex items-start justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent/50"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {account.email ?? account.key}
                  </span>
                  {account.plan && (
                    <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
                      {account.plan}
                    </Badge>
                  )}
                </div>
                <AccountUsageBlock info={usage[account.key]} />
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={loginBusy || loggingOut !== null}
                onClick={() => void handleLogout(account.key)}
              >
                {loggingOut === account.key ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LogOut className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t('Log out')}
              </Button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {canAddAccount && (
        <Button
          className="w-full"
          disabled={loginBusy || loggingOut !== null}
          onClick={onStartLogin}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {provider.accounts.length === 0 ? t('Connect subscription') : t('Add another account')}
        </Button>
      )}
    </div>
  );
}

export function AccountUsageBlock({ info }: { info: OauthAccountUsage | undefined }) {
  const { t } = useI18n();
  if (!info) return null;
  if (info.error) {
    return <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">{info.error}</p>;
  }
  if (info.windows.length === 0) return null;

  const resetLabel = (resetsAt?: number) => {
    if (!resetsAt) return null;
    const value = new Date(resetsAt).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return t('Resets {{time}}', { time: value });
  };

  return (
    <div className="mt-1 min-w-0 space-y-1 overflow-hidden">
      {info.windows.map((windowInfo) => {
        const reset = resetLabel(windowInfo.resetsAt);
        return (
          <div key={windowInfo.label} className="flex min-w-0 items-center gap-2 text-[11px]">
            <span className="w-24 shrink-0 truncate text-muted-foreground" title={windowInfo.label}>
              {windowInfo.label}
            </span>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary/70"
                style={{ width: `${Math.max(0, Math.min(100, windowInfo.usedPercent))}%` }}
              />
            </div>
            <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
              {Math.round(windowInfo.usedPercent)}%
            </span>
            {reset && (
              <span className="min-w-0 truncate text-right text-muted-foreground/70" title={reset}>
                {reset}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
