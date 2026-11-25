import type { OauthAccount, OauthAccountUsage, OauthProviderInfo } from '@shared/types';
import { CircleAlert, Download, Loader2, LogOut, Plus } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { type TFunction, useI18n } from '@/i18n';

export const autoProviderName = (providerName: string, account: OauthAccount): string => {
  const label = account.email ?? (account.key === account.providerId ? null : account.key);
  return label ? `${providerName} (${label})` : providerName;
};

interface OauthProviderAccountsProps {
  provider: OauthProviderInfo;
  loginBusy: boolean;
  onStartLogin: () => void;
  onChanged: () => Promise<void>;
  /** 从本机 Codex 登录态导入成功后的回调；只有 openai-codex 会用到 */
  onImported?: (account: OauthAccount) => Promise<void>;
}

/** 支持从本机应用复制已登录凭证的 provider */
const CODEX_PROVIDER_ID = 'openai-codex';

function importFailureMessage(
  t: TFunction,
  result: Exclude<
    Awaited<ReturnType<typeof window.electronAPI.providers.oauthImportCodex>>,
    { status: 'imported' }
  >
): string {
  switch (result.status) {
    case 'not-found':
      return t('Codex login not found. Sign in to Codex Desktop or CLI first.');
    case 'not-logged-in':
      return t('Codex is not signed in with a ChatGPT account.');
    case 'duplicate':
      return t('This ChatGPT account is already connected.');
    case 'failed':
      return result.message;
  }
}

/** 统一向导订阅分支里的账号详情；授权状态本身由 OauthLoginStep 单独承载。 */
export function OauthProviderAccounts({
  provider,
  loginBusy,
  onStartLogin,
  onChanged,
  onImported,
}: OauthProviderAccountsProps) {
  const { t } = useI18n();
  const [usage, setUsage] = React.useState<Record<string, OauthAccountUsage>>({});
  const [loggingOut, setLoggingOut] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
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
  const busy = loginBusy || loggingOut !== null || importing;

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const result = await window.electronAPI.providers.oauthImportCodex();
      if (result.status === 'imported') {
        await onImported?.(result.account);
      } else {
        setError(importFailureMessage(t, result));
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {provider.accounts.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          <p>{t('No subscription account connected')}</p>
          <p className="mt-1 text-xs">
            {t('Authorize this provider to add its available models.')}
          </p>
        </div>
      ) : (
        <div>
          {provider.accounts.map((account) => (
            <div
              key={account.key}
              className="flex min-w-0 items-start justify-between gap-3 border-border border-b px-1 py-2 transition-colors hover:bg-accent/50"
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
                disabled={busy}
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
        <div className="flex items-start gap-2 rounded-md bg-destructive/5 px-3 py-2 text-xs text-destructive-text">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {canAddAccount && (
        <div className="space-y-2">
          <Button className="w-full" disabled={busy} onClick={onStartLogin}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {provider.accounts.length === 0 ? t('Connect subscription') : t('Add another account')}
          </Button>
          {provider.id === CODEX_PROVIDER_ID && onImported && (
            <Button
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => void handleImport()}
            >
              {importing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t('Import from Codex')}
            </Button>
          )}
        </div>
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
