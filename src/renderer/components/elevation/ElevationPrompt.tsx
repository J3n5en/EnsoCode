import type { ElevationRequestView } from '@shared/elevation';
import { KeyRound } from 'lucide-react';
import * as React from 'react';
import { RequestCountdown, useRemainingMs } from '@/components/chat/RequestCountdown';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

function useElevationRequests(): ElevationRequestView[] {
  const [requests, setRequests] = React.useState<ElevationRequestView[]>([]);
  React.useEffect(() => {
    let alive = true;
    const off = window.electronAPI.elevation.onChanged((views) => setRequests(views));
    void window.electronAPI.elevation.pending().then((views) => {
      if (alive) setRequests(views);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return requests;
}

/** bash 提权口令卡：与命令审批卡同位置同样式，挂在 composer 上方（不分会话，Main 全局只有一份） */
export function ElevationBar() {
  const requests = useElevationRequests();
  const active = requests[0];
  if (!active) return null;
  return <ElevationCard key={active.id} request={active} total={requests.length} />;
}

function ElevationCard({ request, total }: { request: ElevationRequestView; total: number }) {
  const { t } = useI18n();
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const remainingMs = useRemainingMs(request.expiresAt);
  const disabled = busy || (remainingMs !== undefined && remainingMs <= 0);

  const answer = (value: string | null) => {
    setBusy(true);
    setPassword('');
    void window.electronAPI.elevation.answer(request.id, value);
  };

  return (
    <form
      data-enso="approval"
      className="mb-1 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (password && !disabled) answer(password);
      }}
    >
      <div className="flex items-center gap-2 text-xs">
        <KeyRound className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {t('Run as administrator')}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <RequestCountdown remainingMs={remainingMs} expiredLabel="Timed out · denied" />
          {total > 1 && (
            <span className="text-[10px] text-muted-foreground tabular-nums">1/{total}</span>
          )}
        </span>
      </div>
      <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs">
        {request.command}
      </pre>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          type="password"
          // biome-ignore lint/a11y/noAutofocus: 卡片出现就是要输口令
          autoFocus
          autoComplete="off"
          value={password}
          disabled={disabled}
          placeholder={t('Login password')}
          aria-invalid={request.retry || undefined}
          onChange={(event) => setPassword(event.currentTarget.value)}
          className={cn(
            'h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus-visible:border-ring',
            request.retry ? 'border-destructive/60' : 'border-border/60'
          )}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => answer(null)}
          className="rounded-md px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
        >
          {t('Deny')}
        </button>
        <button
          type="submit"
          disabled={disabled || !password}
          className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {t('Allow')}
        </button>
      </div>
      <p
        className={cn(
          'mt-1 text-[11px]',
          request.retry ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {request.retry
          ? t('Incorrect password. Try again.')
          : t('Applies to this command only. The password is never shown to the AI.')}
      </p>
    </form>
  );
}
