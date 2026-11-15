import { CONTACT_COMMANDS } from '@shared/secretary/commands';
import type { SecretaryContactState } from '@shared/types/secretary';
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  RadioTower,
  RefreshCw,
  Send,
  ShieldAlert,
  Unlink,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

const BOTFATHER_URL = 'https://t.me/BotFather';

/** Main 只回稳定的错误码，文案在这里翻 */
const ERROR_TEXT: Record<string, string> = {
  'token-invalid': 'That does not look like a bot token',
  network: 'Cannot reach api.telegram.org. Check the proxy.',
  unauthorized: 'Telegram rejected this token',
  api: 'Telegram returned an error',
  'token-required': 'Paste a bot token first',
  'not-bound': 'Not bound yet',
  'no-secretary': 'No secretary conversation is available',
  'deliver-failed': 'Could not reach the secretary session',
  'invalid sender': 'Not allowed from this window',
};

const STEP_CLASS = 'rounded-xl border border-border px-3 py-2.5';
const BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12.5px] transition-colors hover:bg-muted disabled:opacity-50';
const PRIMARY_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg bg-foreground px-2.5 py-1.5 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50';

function StepHead({ index, label }: { index: number; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
      <span className="flex size-4 items-center justify-center rounded-full bg-muted text-[10px] tabular-nums">
        {index}
      </span>
      {label}
    </div>
  );
}

/** 联系方式：第一个渠道是 Telegram Bot。绑定向导尽量少步骤，不让用户手抄 chat_id */
export function SecretaryContactPanel() {
  const { t } = useI18n();
  const [state, setState] = useState<SecretaryContactState | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  const load = useCallback(() => {
    void window.electronAPI.secretary.contactState().then(setState);
  }, []);

  useEffect(() => {
    load();
    return window.electronAPI.secretary.onContactChanged(setState);
  }, [load]);

  const link = state?.telegram.bind?.link;
  useEffect(() => {
    if (!link) {
      setQr(null);
      return;
    }
    let alive = true;
    void QRCode.toDataURL(link, { width: 320, margin: 1 })
      .then((data) => {
        if (alive) setQr(data);
      })
      .catch(() => setQr(null));
    return () => {
      alive = false;
    };
  }, [link]);

  const run = (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    void action()
      .then((result) => {
        if (!result.ok) setError(result.error ?? 'api');
      })
      .finally(() => {
        setBusy(false);
        load();
      });
  };

  if (!state) return null;
  const telegram = state.telegram;
  const pollFailed = telegram.poll.state === 'error' || telegram.poll.state === 'backoff';
  const minutes = telegram.bind
    ? Math.max(0, Math.round((telegram.bind.expiresAt - Date.now()) / 60_000))
    : 0;

  return (
    <div data-enso="secretary-contact" className="flex flex-col gap-2 px-3 py-3">
      <p className="px-1 text-[11.5px] text-muted-foreground">
        {t('Reach the secretary from your phone. Milestones go out; your replies come back.')}
      </p>

      {(error || pollFailed) && (
        <div
          data-enso="secretary-contact-error"
          className="flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[12px] text-destructive"
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {error
              ? t(ERROR_TEXT[error] ?? 'Telegram returned an error')
              : t('Cannot reach api.telegram.org. Check the proxy.')}
          </span>
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-1.5 rounded-lg border border-success/40 bg-success/5 px-2.5 py-2 text-[12px] text-success">
          <Check className="size-3.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {telegram.status === 'bound' && (
        <>
          <div data-enso="secretary-contact-bound" className={STEP_CLASS}>
            <div className="flex items-center gap-2">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
                <Check className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">
                  {t('Bound to @{{username}}', {
                    username: telegram.chat?.username ?? String(telegram.chat?.id ?? ''),
                  })}
                </p>
                <p className="truncate text-[11.5px] text-muted-foreground">
                  {t('Bot @{{bot}}', { bot: telegram.bot?.username ?? '' })}
                  {telegram.tokenHint ? ` · ${telegram.tokenHint}` : ''}
                </p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                data-enso="secretary-contact-test"
                disabled={busy}
                className={BUTTON_CLASS}
                onClick={() =>
                  run(() =>
                    window.electronAPI.secretary.contactTest().then((result) => {
                      if (result.ok) setNotice(t('Test message sent'));
                      return result;
                    })
                  )
                }
              >
                <Send className="size-3.5" />
                {t('Send a test message')}
              </button>
              <button
                type="button"
                data-enso="secretary-contact-unbind"
                disabled={busy}
                className={BUTTON_CLASS}
                onClick={() => run(() => window.electronAPI.secretary.contactUnbind())}
              >
                <Unlink className="size-3.5" />
                {t('Unbind')}
              </button>
              <button
                type="button"
                data-enso="secretary-contact-replace"
                disabled={busy}
                className={BUTTON_CLASS}
                onClick={() => run(() => window.electronAPI.secretary.contactForgetBot())}
              >
                <RefreshCw className="size-3.5" />
                {t('Change bot')}
              </button>
            </div>
          </div>

          <div className={STEP_CLASS}>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                data-enso="secretary-contact-allow-dispatch"
                className="mt-0.5"
                checked={telegram.allowCardConfirm}
                onChange={(event) =>
                  run(() =>
                    window.electronAPI.secretary.contactSettings({
                      allowCardConfirm: event.target.checked,
                    })
                  )
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px]">
                  {t('Allow confirming cards from Telegram')}
                </span>
                <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                  {t(
                    'Off by default. Turning it on lets a tap on your phone confirm dispatch, settings, skill, tool and takeover cards. Those cards change how much the secretary may do on its own, which projects it sees, what it may take over, and which skills and tools it installs. Approvals are never handled from Telegram.'
                  )}
                </span>
              </span>
            </label>
          </div>

          <div className={STEP_CLASS}>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                data-enso="secretary-contact-allow-memory"
                className="mt-0.5"
                checked={telegram.allowMemory}
                onChange={(event) =>
                  run(() =>
                    window.electronAPI.secretary.contactSettings({
                      allowMemory: event.target.checked,
                    })
                  )
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px]">
                  {t('Allow viewing memory titles on Telegram')}
                </span>
                <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                  {t('Off by default. /memory lists titles only, never the memory text.')}
                </span>
              </span>
            </label>
          </div>

          <div
            data-enso="secretary-contact-sync"
            className={cn(STEP_CLASS, telegram.syncMirror && 'border-warning/50 bg-warning/5')}
          >
            {telegram.syncMirror ? (
              <>
                <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-warning">
                  <RadioTower className="size-3.5 shrink-0" />
                  {t('Mirroring every conversation to Telegram')}
                </div>
                <p className="mt-1 text-[11.5px] text-muted-foreground">
                  {t(
                    'Every reply in the secretary conversation is sent to your phone, not just milestones. Silent turns arrive as a one-line summary. Telegram messages are not end-to-end encrypted and stay on Telegram servers. Send /sync off in Telegram to stop.'
                  )}
                </p>
              </>
            ) : (
              <p className="text-[11.5px] text-muted-foreground">
                {t(
                  'Only milestones go to Telegram. Send /sync in Telegram to mirror every reply; /last replays the latest round.'
                )}
              </p>
            )}
          </div>

          <div data-enso="secretary-contact-commands" className={STEP_CLASS}>
            <div className="text-[12px] font-medium text-muted-foreground">
              {t('Commands you can send')}
            </div>
            <ul className="mt-1 flex flex-col gap-0.5">
              {CONTACT_COMMANDS.filter((spec) => !spec.gated || telegram.allowMemory).map(
                (spec) => (
                  <li key={spec.name} className="text-[12px]">
                    <code className="rounded bg-muted px-1 text-[11.5px]">/{spec.name}</code>{' '}
                    <span className="text-muted-foreground">{t(spec.en)}</span>
                  </li>
                )
              )}
            </ul>
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">
              {t(
                'Telegram messages are not end-to-end encrypted and stay on Telegram servers. /status, /board and /feed show titles and short summaries; /last and /sync send conversation text. Memory text and tool output never leave the app.'
              )}
            </p>
          </div>

          {!telegram.secure && (
            <p className="px-1 text-[11.5px] text-warning">
              {t(
                'No system keychain available: the bot token is stored unencrypted on this machine.'
              )}
            </p>
          )}
        </>
      )}

      {telegram.status === 'awaiting-start' && (
        <>
          <div data-enso="secretary-contact-verified" className={STEP_CLASS}>
            <StepHead index={2} label={t('Bot verified')} />
            <p className="mt-1 text-[13px] font-medium">
              {telegram.bot?.name}{' '}
              <span className="text-muted-foreground">@{telegram.bot?.username}</span>
            </p>
          </div>
          <div data-enso="secretary-contact-code" className={STEP_CLASS}>
            <StepHead index={3} label={t('Open the bot and press Start')} />
            <div className="mt-2 flex items-center gap-3">
              {qr && (
                <img
                  data-enso="secretary-contact-qr"
                  src={qr}
                  alt={t('Binding QR code')}
                  className="size-28 shrink-0 rounded-lg bg-white p-1"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[11.5px] text-muted-foreground">{t('Binding code')}</p>
                <p
                  data-enso="secretary-contact-code-value"
                  className="font-mono text-[22px] tracking-[0.2em] tabular-nums"
                >
                  {telegram.bind?.code}
                </p>
                <p className="mt-1 text-[11.5px] text-subtle-foreground">
                  {t('Valid for {{minutes}} more minutes', { minutes })}
                </p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <a
                data-enso="secretary-contact-open-bot"
                href={telegram.bind?.link}
                target="_blank"
                rel="noreferrer"
                className={PRIMARY_CLASS}
              >
                <ExternalLink className="size-3.5" />
                {t('Open @{{bot}}', { bot: telegram.bot?.username ?? '' })}
              </a>
              <button
                type="button"
                data-enso="secretary-contact-copy"
                className={BUTTON_CLASS}
                onClick={() => {
                  void navigator.clipboard.writeText(telegram.bind?.link ?? '');
                  setNotice(t('Link copied'));
                }}
              >
                <Copy className="size-3.5" />
                {t('Copy link')}
              </button>
              <button
                type="button"
                data-enso="secretary-contact-regenerate"
                disabled={busy}
                className={BUTTON_CLASS}
                onClick={() => run(() => window.electronAPI.secretary.contactBind())}
              >
                <RefreshCw className="size-3.5" />
                {t('New code')}
              </button>
              <button
                type="button"
                data-enso="secretary-contact-cancel"
                disabled={busy}
                className={BUTTON_CLASS}
                onClick={() => run(() => window.electronAPI.secretary.contactCancel())}
              >
                {t('Cancel')}
              </button>
            </div>
            <p className="mt-2 text-[11.5px] text-subtle-foreground">
              {t('The code works once, in a private chat with this bot only.')}
            </p>
          </div>
        </>
      )}

      {telegram.status === 'unbound' && (
        <>
          <div data-enso="secretary-contact-step1" className={STEP_CLASS}>
            <StepHead index={1} label={t('Create a bot with @BotFather')} />
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              {t('Send /newbot, pick a name, and copy the token it gives you.')}
            </p>
            <a
              data-enso="secretary-contact-botfather"
              href={BOTFATHER_URL}
              target="_blank"
              rel="noreferrer"
              className={cn(BUTTON_CLASS, 'mt-2')}
            >
              <ExternalLink className="size-3.5" />
              {t('Open @BotFather')}
            </a>
            <input
              data-enso="secretary-contact-token"
              type="password"
              value={token}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('Paste the bot token')}
              onChange={(event) => setToken(event.target.value)}
              className="mt-2 w-full rounded-lg border border-border bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-foreground/40"
            />
            <button
              type="button"
              data-enso="secretary-contact-verify"
              disabled={busy || token.trim().length === 0}
              className={cn(PRIMARY_CLASS, 'mt-2')}
              onClick={() => run(() => window.electronAPI.secretary.contactBind(token.trim()))}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              {t('Verify and continue')}
            </button>
            {telegram.bot && (
              <button
                type="button"
                data-enso="secretary-contact-reconnect"
                disabled={busy}
                className={cn(BUTTON_CLASS, 'mt-1.5')}
                onClick={() => run(() => window.electronAPI.secretary.contactBind())}
              >
                <RefreshCw className="size-3.5" />
                {t('Bind again with @{{bot}}', { bot: telegram.bot.username })}
              </button>
            )}
          </div>
          <p className="px-1 text-[11.5px] text-subtle-foreground">
            {t('The token is stored with the system keychain and never written to logs.')}
          </p>
        </>
      )}
    </div>
  );
}
