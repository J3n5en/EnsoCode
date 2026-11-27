import type { ExtensionPluginSummary } from '@shared/extensionPlugins/types';
import { CONTACT_COMMANDS } from '@shared/secretary/commands';
import type {
  SecretaryContactChannelPrefs,
  SecretaryContactChannelStatus,
  SecretaryContactChannelView,
  SecretaryContactOutboundHealth,
  SecretaryContactState,
} from '@shared/types/secretary';
import { AnimatePresence, MotionGlobalConfig, motion, useReducedMotion } from 'framer-motion';
import {
  Check,
  ChevronRight,
  CirclePause,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  RadioTower,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Unlink,
} from 'lucide-react';
import QRCode from 'qrcode';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  SettingsButton,
  SettingsRow,
  SettingsSegmented,
  SettingsSubRow,
  SettingsSwitch,
  useSettingsRowControl,
} from '@/components/settings/kit';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { heightVariants } from '@/lib/motion';
import { formatClock, formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { PluginIcon } from '@/plugins/PluginIcon';
import { PluginFrame } from '@/plugins/PluginView';
import { openSettings } from '@/stores/appView';
import { SecretaryContactGroupRow } from './SecretaryContactGroupRow';
import {
  privateChatOwner,
  SecretaryContactBindPlaces,
  SecretaryContactBindRejection,
  SecretaryContactOtherGroups,
  SecretaryContactSharedBot,
} from './SecretaryContactSharedBot';

const BOTFATHER_URL = 'https://t.me/BotFather';

/** Main 只回稳定的错误码，文案在这里翻 */
const ERROR_TEXT: Record<string, string> = {
  'token-invalid': 'That does not look like a bot token',
  network: 'Cannot reach api.telegram.org. Check the proxy.',
  unauthorized: 'Telegram rejected this token',
  api: 'Telegram returned an error',
  'token-required': 'Paste a bot token first',
  'not-bound': 'Not bound yet',
  'not-found': 'That task is already gone',
  'no-secretary': 'No secretary conversation is available',
  'deliver-failed': 'Could not reach the secretary session',
  'invalid-chat-id': 'Group chat IDs are numbers, e.g. -1001234567890',
  'channel-paused': 'Pushes to this channel are paused after repeated failures',
  'invalid sender': 'Not allowed from this window',
  'invalid-github-login': 'That is not a GitHub login',
};

/** 渠道展开区（settings-sub-group）里的信息块：与子行文本同一左缩进，发丝线由分组 CSS 画 */
const SUB_PAD = 'py-2.5 pl-10 pr-4 max-sm:pl-7 max-sm:pr-3';
const BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12.5px] transition-colors hover:bg-muted disabled:opacity-50';
const LINK_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-muted/80';
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

const STATUS_LABEL: Record<SecretaryContactChannelStatus, string> = {
  unconfigured: 'Not set up',
  pending: 'Waiting to bind',
  connected: 'Connected',
  error: 'Error',
};

const STATUS_CLASS: Record<SecretaryContactChannelStatus, string> = {
  unconfigured: 'bg-muted text-muted-foreground',
  pending: 'bg-warning/15 text-warning',
  connected: 'bg-success/15 text-success',
  error: 'bg-destructive/15 text-destructive',
};

/** 卡片折叠只记在界面本地：不进 Main、不进 settings.json */
const COLLAPSE_KEY = 'enso.secretary.contact.collapsed';

function readCollapsed(): Record<string, boolean> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(([, value]) => value === true)
    ) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function writeCollapsed(value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(value));
  } catch {
    /* 存不下就只在本次会话里记 */
  }
}

/** 插件渠道出站失败：最近一次的时间和原因，插件给的提示原样展示；暂停中说清楚何时再试 */
function OutboundNotice({
  outbound,
  busy,
  onRetry,
}: {
  outbound: SecretaryContactOutboundHealth;
  busy: boolean;
  onRetry: () => void;
}) {
  const { t, locale } = useI18n();
  const now = Date.now();
  const paused = outbound.state === 'paused';
  const waiting = paused && outbound.pausedUntil !== undefined && outbound.pausedUntil > now;
  return (
    <div
      data-enso="secretary-contact-outbound"
      data-state={outbound.state}
      className={cn(
        'border-l-2 px-4 py-2.5 text-[12px]',
        paused ? 'border-warning bg-warning/5' : 'border-destructive bg-destructive/5'
      )}
    >
      <div
        className={cn(
          'flex items-center gap-1.5 font-medium',
          paused ? 'text-warning' : 'text-destructive'
        )}
      >
        {paused ? (
          <CirclePause className="size-3.5 shrink-0" />
        ) : (
          <ShieldAlert className="size-3.5 shrink-0" />
        )}
        {paused
          ? t('Pushes paused: {{count}} sends failed in a row', {
              count: outbound.consecutiveFailures,
            })
          : t('The last send failed ({{count}} in a row)', {
              count: outbound.consecutiveFailures,
            })}
      </div>
      {outbound.userMessage && (
        <p data-enso="secretary-contact-outbound-hint" className="mt-1 text-[12.5px]">
          {outbound.userMessage}
        </p>
      )}
      <p className="mt-1 text-[11.5px] text-muted-foreground">
        {t('Last failure: {{time}}', {
          time: `${formatClock(outbound.lastErrorAt, locale)} (${formatRelativeTime(outbound.lastErrorAt, locale, now)})`,
        })}
      </p>
      {outbound.detail && (
        <p
          data-enso="secretary-contact-outbound-detail"
          className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground"
        >
          {outbound.detail}
        </p>
      )}
      {paused && (
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          {waiting
            ? t(
                'Next try at {{time}}. A message from this channel or Retry now resumes pushes right away.',
                { time: formatClock(outbound.pausedUntil ?? now, locale) }
              )
            : t('The next push will try again.')}
          {outbound.suppressedCount > 0 &&
            ` ${t('{{count}} pushes held back.', { count: outbound.suppressedCount })}`}
        </p>
      )}
      <button
        type="button"
        data-enso="secretary-contact-outbound-retry"
        disabled={busy}
        className={cn(BUTTON_CLASS, 'mt-1.5')}
        onClick={onRetry}
      >
        <RefreshCw className="size-3.5" />
        {t('Retry now')}
      </button>
      <span className="ml-2 text-[11px] text-subtle-foreground">
        {t('Sends a test message to this channel.')}
      </span>
    </div>
  );
}

/** 同样用 Telegram bot token 的远程操作插件：两边抢同一个 bot 会互相吞消息 */
const TELEGRAM_REMOTE_PLUGIN = 'enso.telegram';

function PrefRow({
  label,
  hint,
  checked,
  disabled,
  dataEnso,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  dataEnso: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <div data-enso={dataEnso}>
      <SettingsSubRow label={label} description={hint}>
        <SettingsSwitch checked={checked} disabled={disabled} onCheckedChange={onChange} />
      </SettingsSubRow>
    </div>
  );
}

/** 一张渠道卡片：头部是图标、名字、内置/插件、状态与启用开关；体是通用开关加登录区 */
function ChannelCard({
  channel,
  collapsed,
  busy,
  onToggle,
  onPrefs,
  onRetry,
  children,
}: {
  channel: SecretaryContactChannelView;
  collapsed: boolean;
  busy: boolean;
  onToggle: () => void;
  onPrefs: (prefs: Partial<SecretaryContactChannelPrefs>) => void;
  onRetry: () => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const telegram = channel.id === 'telegram';
  const { prefs, caps } = channel;
  const limits = [
    !caps.buttons && t('No buttons: questions and cards arrive as numbered text.'),
    !caps.edit && t('Cannot edit sent messages: answered questions are not marked there.'),
    !caps.typing && t('No typing indicator.'),
  ].filter((item): item is string => typeof item === 'string');
  const open = !collapsed;
  const regionId = `secretary-contact-channel-${channel.id}-body`;
  const reducedMotion = useReducedMotion();
  const reduced = reducedMotion === true || MotionGlobalConfig.skipAnimations === true;
  return (
    <div data-enso="secretary-contact-channel" data-channel={channel.id}>
      <SettingsRow
        interactive
        label={
          // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘走左侧的展开按钮
          <span
            className="cursor-pointer"
            onClick={(event) => {
              event.preventDefault();
              onToggle();
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              {channel.pluginId ? (
                <PluginIcon pluginId={channel.pluginId} icon={channel.icon} className="size-4" />
              ) : (
                <Send className="size-4 shrink-0" />
              )}
              <span className="truncate">{channel.title}</span>
              <span className="shrink-0 rounded bg-muted px-1 text-[10.5px] font-normal text-muted-foreground">
                {channel.builtin ? t('Built-in') : t('Plugin')}
              </span>
            </span>
          </span>
        }
        leading={
          <button
            type="button"
            data-enso="secretary-contact-channel-toggle"
            aria-expanded={open}
            aria-controls={regionId}
            aria-label={open ? t('Collapse') : t('Expand')}
            onClick={onToggle}
            className="relative -ml-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
          >
            <ChevronRight
              className={cn(
                'size-4 transition-transform duration-200 ease-[var(--ease-smooth-out)]',
                open && 'rotate-90'
              )}
            />
          </button>
        }
        status={
          <>
            <span
              data-enso="secretary-contact-channel-status"
              className={cn('shrink-0 rounded px-1 text-[10.5px]', STATUS_CLASS[channel.status])}
            >
              {t(STATUS_LABEL[channel.status])}
            </span>
            {channel.outbound && (
              <span
                data-enso="secretary-contact-channel-outbound"
                className={cn(
                  'shrink-0 rounded px-1 text-[10.5px]',
                  channel.outbound.state === 'paused'
                    ? 'bg-warning/15 text-warning'
                    : 'bg-destructive/15 text-destructive'
                )}
              >
                {channel.outbound.state === 'paused' ? t('Pushes paused') : t('Send failed')}
              </span>
            )}
          </>
        }
      >
        <Switch
          data-enso="secretary-contact-channel-enabled"
          checked={prefs.enabled}
          disabled={busy}
          aria-label={t('Enable {{name}}', { name: channel.title })}
          onCheckedChange={(checked) => onPrefs({ enabled: checked })}
        />
      </SettingsRow>
      {reduced ? (
        open ? (
          <div
            id={regionId}
            data-slot="settings-sub-group"
            className="overflow-hidden border-t border-border/60 bg-muted/45 dark:bg-background/40"
          >
            <ChannelBody
              channel={channel}
              telegram={telegram}
              limits={limits}
              busy={busy}
              onPrefs={onPrefs}
              onRetry={onRetry}
            >
              {children}
            </ChannelBody>
          </div>
        ) : null
      ) : (
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              id={regionId}
              data-slot="settings-sub-group"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={heightVariants}
              className="overflow-hidden border-t border-border/60 bg-muted/45 dark:bg-background/40"
            >
              <ChannelBody
                channel={channel}
                telegram={telegram}
                limits={limits}
                busy={busy}
                onPrefs={onPrefs}
                onRetry={onRetry}
              >
                {children}
              </ChannelBody>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}

/** 渠道展开体：通用开关行加登录区内容，块统一缩进对齐子行文本 */
function ChannelBody({
  channel,
  telegram,
  limits,
  busy,
  onPrefs,
  onRetry,
  children,
}: {
  channel: SecretaryContactChannelView;
  telegram: boolean;
  limits: string[];
  busy: boolean;
  onPrefs: (prefs: Partial<SecretaryContactChannelPrefs>) => void;
  onRetry: () => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const { prefs, caps } = channel;
  return (
    <>
      {channel.detail && channel.status === 'error' && (
        <p className={cn(SUB_PAD, 'text-[11.5px] text-destructive')}>{channel.detail}</p>
      )}
      {channel.outbound && (
        <OutboundNotice outbound={channel.outbound} busy={busy} onRetry={onRetry} />
      )}
      <PrefRow
        dataEnso="secretary-contact-push"
        label={t('Push to this channel')}
        hint={t(
          'Milestones, questions from the secretary, cards and approval notices go out here.'
        )}
        checked={prefs.push}
        disabled={busy}
        onChange={(value) => onPrefs({ push: value })}
      />
      <PrefRow
        dataEnso={telegram ? 'secretary-contact-allow-dispatch' : 'secretary-contact-card-confirm'}
        label={
          telegram ? t('Allow confirming cards from Telegram') : t('Confirm cards from the phone')
        }
        hint={
          telegram
            ? t(
                'On by default. A tap on your phone can confirm settings, skill, tool, takeover and cleanup cards. Those cards change which projects the secretary sees, what it may take over, which skills and tools it installs and what it cleans up. Approvals have their own switch below.'
              )
            : caps.buttons
              ? t('Off by default. Approvals are never handled from the phone.')
              : t(
                  'Off by default. Reply "confirm 1" to confirm a card. Approvals are never handled from the phone.'
                )
        }
        checked={prefs.cardConfirm}
        disabled={busy}
        onChange={(value) => onPrefs({ cardConfirm: value })}
      />
      {telegram && (
        <PrefRow
          dataEnso="secretary-contact-approval-remote"
          label={t('Approve from Telegram')}
          hint={t(
            'Off by default. Approval cards from every conversation go to your private chat only. When on, file edits and ordinary commands get Approve and Deny buttons; high-risk actions (git push, deletes, publishing, secrets, MCP tools) still need the computer.'
          )}
          checked={prefs.approvalRemote}
          disabled={busy}
          onChange={(value) => onPrefs({ approvalRemote: value })}
        />
      )}
      <PrefRow
        dataEnso="secretary-contact-mirror"
        label={t('Mirror every reply')}
        hint={t(
          'Off by default. Every reply in the secretary conversation is sent here, not just milestones.'
        )}
        checked={prefs.syncMirror}
        disabled={busy}
        onChange={(value) => onPrefs({ syncMirror: value })}
      />
      <PrefRow
        dataEnso={telegram ? 'secretary-contact-allow-memory' : 'secretary-contact-memory'}
        label={
          telegram ? t('Allow viewing memory titles on Telegram') : t('Allow viewing memory titles')
        }
        hint={t('Off by default. /memory lists titles only, never the memory text.')}
        checked={prefs.memory}
        disabled={busy}
        onChange={(value) => onPrefs({ memory: value })}
      />
      {limits.length > 0 && (
        <ul
          data-enso="secretary-contact-limits"
          className={cn(SUB_PAD, 'flex flex-col gap-0.5 text-[11.5px] text-subtle-foreground')}
        >
          {limits.map((item) => (
            <li key={item}>· {item}</li>
          ))}
        </ul>
      )}
      {children}
    </>
  );
}

/** 主人身份卡里 GitHub 账号的输入框：受控草稿在父组件，这里只接 a11y 与样式 */
function OwnerLoginsInput({
  value,
  disabled,
  placeholder,
  onChange,
}: {
  value: string;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const a11y = useSettingsRowControl();
  return (
    <Input
      {...a11y}
      id="secretary-github-logins"
      data-enso="secretary-contact-github-logins"
      size="sm"
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => onChange((event.currentTarget ?? event.target).value)}
      className="w-[240px] max-w-full"
    />
  );
}

function OwnerIdentity({
  owner,
  secretaryId,
  busy,
  error,
  run,
}: {
  owner: SecretaryContactState['owner'];
  secretaryId?: string;
  busy: boolean;
  error: string | null;
  run: (action: () => Promise<{ ok: boolean; error?: string }>) => void;
}) {
  const { t } = useI18n();
  const saved = owner.githubLogins.join(', ');
  const bound = owner.githubLogins.length > 0;
  const [draft, setDraft] = useState(saved);
  const [dirty, setDirty] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [saved, dirty]);

  useEffect(() => {
    if (bound) {
      setSuggestion(null);
      return;
    }
    const suggest = window.electronAPI.secretary.contactGithubSuggest;
    if (!suggest) return;
    let alive = true;
    void suggest().then((result) => {
      if (alive) setSuggestion(result.login);
    });
    return () => {
      alive = false;
    };
  }, [bound]);

  const fill = (login: string) => {
    setDirty(true);
    setDraft((current) => {
      const parts = current.split(/[\s,]+/).filter(Boolean);
      if (parts.some((part) => part.toLowerCase() === login.toLowerCase())) return current;
      return parts.length > 0 ? `${parts.join(', ')}, ${login}` : login;
    });
  };

  return (
    <div data-enso="secretary-contact-owner">
      <SettingsRow
        rowId="contacts.github-accounts"
        label={t('GitHub accounts')}
        description={
          suggestion || error === 'invalid-github-login' ? (
            <>
              {suggestion && (
                <span className="inline-flex flex-wrap items-center gap-x-1.5">
                  {t('Detected the gh login {{login}} on this machine', { login: suggestion })}
                  <button
                    type="button"
                    data-enso="secretary-contact-github-fill"
                    disabled={busy}
                    className="font-medium text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground/70 disabled:opacity-50"
                    onClick={() => fill(suggestion)}
                  >
                    {t('Fill in')}
                  </button>
                </span>
              )}
              {error === 'invalid-github-login' && (
                <span className="mt-0.5 block text-destructive">
                  {t('That is not a GitHub login')}
                </span>
              )}
            </>
          ) : undefined
        }
      >
        <OwnerLoginsInput
          value={draft}
          disabled={busy}
          placeholder={t('Comma or space separated')}
          onChange={(value) => {
            setDirty(true);
            setDraft(value);
          }}
        />
        <SettingsButton
          data-enso="secretary-contact-github-save"
          disabled={busy || !dirty}
          onClick={() => {
            const githubLogins = draft
              .split(/[\s,]+/)
              .map((item) => item.trim())
              .filter(Boolean);
            run(async () => {
              const result = await window.electronAPI.secretary.contactSettings(
                { githubLogins },
                secretaryId
              );
              if (result.ok) setDirty(false);
              return result;
            });
          }}
        >
          {t('Save GitHub accounts')}
        </SettingsButton>
      </SettingsRow>
      <SettingsRow
        rowId="contacts.external-messages"
        label={t('Messages that are not from you')}
        description={t(
          'Events from anyone else are left to the agent unless you require confirmation.'
        )}
      >
        <SettingsSegmented
          aria-label={t('Messages that are not from you')}
          value={owner.externalConfirm ? 'confirm' : 'agent'}
          options={[
            {
              value: 'agent',
              label: t('Let the agent decide'),
              dataEnso: 'secretary-contact-external-agent',
            },
            {
              value: 'confirm',
              label: t('Require your confirmation'),
              dataEnso: 'secretary-contact-external-confirm',
            },
          ]}
          onValueChange={(value) => {
            const externalConfirm = value === 'confirm';
            if (externalConfirm === owner.externalConfirm) return;
            run(() =>
              window.electronAPI.secretary.contactSettings({ externalConfirm }, secretaryId)
            );
          }}
        />
      </SettingsRow>
    </div>
  );
}

/**
 * 联系方式：总开关、主人身份、渠道（Telegram 内置固定第一位，插件渠道跟在后面）。
 * 设置页传入 frames，把总开关和主人身份、渠道内容分到两个分组；不传时仍是一整块。
 */
export type SecretaryContactFrames = {
  owner: (node: ReactNode) => ReactNode;
  channels: (node: ReactNode) => ReactNode;
};

function EnableSwitch({
  checked,
  disabled,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  const row = useSettingsRowControl();
  return (
    <Switch
      {...row}
      data-enso="secretary-contact-enabled"
      checked={checked}
      disabled={disabled}
      aria-label={row['aria-labelledby'] ? undefined : label}
      onCheckedChange={onCheckedChange}
    />
  );
}

export function SecretaryContactPanel({
  secretaryId,
  frames,
}: {
  secretaryId?: string;
  frames: SecretaryContactFrames;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<SecretaryContactState | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const [plugins, setPlugins] = useState<ExtensionPluginSummary[]>([]);
  const [groupInput, setGroupInput] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const api = window.electronAPI.extensionPlugins;
    const refresh = () => {
      void api
        .list()
        .then(setPlugins)
        .catch(() => setPlugins([]));
    };
    refresh();
    return api.onChanged(refresh);
  }, []);

  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      writeCollapsed(next);
      return next;
    });
  };

  const load = useCallback(() => {
    void window.electronAPI.secretary.contactState(secretaryId).then(setState);
  }, [secretaryId]);

  useEffect(() => {
    load();
    // 推送是全部秘书共用的：只收自己这份
    return window.electronAPI.secretary.onContactChanged((next) => {
      if (secretaryId && next.secretaryId && next.secretaryId !== secretaryId) return;
      setState(next);
    });
  }, [load, secretaryId]);

  const expiresAt = state?.telegram.bind?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

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
  const channels = state.channels ?? [];
  const tokenConflict = plugins.some(
    (plugin) => plugin.id === TELEGRAM_REMOTE_PLUGIN && plugin.state === 'enabled'
  );
  const setPrefs = (channelId: string, prefs: Partial<SecretaryContactChannelPrefs>) =>
    run(() => window.electronAPI.secretary.contactSettings({ channelId, prefs }, secretaryId));
  // 重试的发送失败写在渠道卡片上（原因与时间），顶部只报没绑定这类发不出去的情况
  const retryChannel = (channelId: string) =>
    run(() =>
      window.electronAPI.secretary.contactTest(secretaryId, channelId).then((result) => {
        if (result.ok) setNotice(t('Test message sent'));
        else if (['api', 'network', 'unauthorized', 'channel-paused'].includes(result.error))
          return { ok: true as const };
        return result;
      })
    );
  const pollFailed = telegram.poll.state === 'error' || telegram.poll.state === 'backoff';
  // 轮询在跑时连不上与否以它为准：动作留下的 network 结果不单独挂着，否则恢复后没人撤
  const pollAlive = telegram.poll.state !== 'stopped' && telegram.poll.state !== 'error';
  const shownError = error === 'network' && pollAlive ? null : error;
  const groups = telegram.groups ?? [];
  const groupDraft = groupInput.trim();
  const setGroup = (action: 'add' | 'remove', chatId: string) =>
    run(() =>
      window.electronAPI.secretary
        .contactSettings({ telegramGroup: { action, chatId } }, secretaryId)
        .then((result) => {
          if (result.ok && action === 'add') setGroupInput('');
          return result;
        })
    );
  const minutes = telegram.bind
    ? Math.max(0, Math.ceil((telegram.bind.expiresAt - now) / 60_000))
    : 0;
  const expired = telegram.bind ? telegram.bind.expiresAt <= now : false;
  // 同一个 bot 的私聊已经归了别的秘书：这个秘书只能认领群和话题
  const privateOwner = telegram.chat ? null : privateChatOwner(telegram.shared);

  const bindPlaces = (
    <SecretaryContactBindPlaces
      bind={telegram.bind}
      bot={telegram.bot?.username}
      now={now}
      busy={busy}
      onNewCode={() => run(() => window.electronAPI.secretary.contactBind(undefined, secretaryId))}
      onCopied={() => setNotice(t('Copied'))}
    />
  );

  const groupsStep = (
    <div data-enso="secretary-contact-groups" className={SUB_PAD}>
      <div className="text-[12px] font-medium text-muted-foreground">{t('Groups and topics')}</div>
      <p className="mt-1 text-[11.5px] text-muted-foreground">
        {t(
          'Only groups on this list reach the secretary, and only messages from the bound account count. Messages from anyone else in the group are not received.'
        )}
      </p>
      {groups.length === 0 ? (
        <>
          {bindPlaces}
          <p className="mt-1.5 text-[11.5px] text-subtle-foreground">
            {t('No groups yet: group messages are not received.')}
          </p>
        </>
      ) : (
        <>
          <ul className="mt-1.5 flex flex-col gap-1">
            {groups.map((group) => (
              <SecretaryContactGroupRow
                key={group.id}
                group={group}
                secretaryId={secretaryId}
                busy={busy}
                onRemove={() => setGroup('remove', group.id)}
                onSaved={load}
              />
            ))}
          </ul>
          <p className="mt-2.5 text-[11.5px] font-medium text-muted-foreground">
            {t('Bind another group or topic')}
          </p>
          {bindPlaces}
        </>
      )}
      <SecretaryContactOtherGroups shared={telegram.shared} />
      <p className="mt-2 text-[11px] text-subtle-foreground">
        {t('Or add a group by its chat ID:')}
      </p>
      <form
        className="mt-1 flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!groupDraft) return;
          if (groups.some((group) => group.id === groupDraft)) {
            setGroupInput('');
            return;
          }
          setGroup('add', groupDraft);
        }}
      >
        <input
          data-enso="secretary-contact-group-input"
          value={groupInput}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('Group chat ID, e.g. -1001234567890')}
          onChange={(event) => setGroupInput(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-foreground/40"
        />
        <button
          type="submit"
          data-enso="secretary-contact-group-add"
          disabled={busy || !groupDraft}
          className={BUTTON_CLASS}
        >
          <Plus className="size-3.5" />
          {t('Add group')}
        </button>
      </form>
    </div>
  );

  const telegramBody = (
    <>
      {tokenConflict && (
        <p
          data-enso="secretary-contact-token-conflict"
          className={cn(SUB_PAD, 'text-[11.5px] text-warning')}
        >
          {t(
            "The Telegram remote plugin (enso.telegram) is enabled. Do not give both the same bot token: only one place can poll a bot, so they would steal each other's messages."
          )}
        </p>
      )}
      {telegram.status === 'bound' && (
        <>
          <div data-enso="secretary-contact-bound" className={SUB_PAD}>
            <div className="flex items-center gap-2">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
                <Check className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">
                  {telegram.chat
                    ? t('Bound to @{{username}}', {
                        username: telegram.chat.username ?? String(telegram.chat.id),
                      })
                    : t('Bound to groups and topics')}
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
                    window.electronAPI.secretary.contactTest(secretaryId).then((result) => {
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
                onClick={() => run(() => window.electronAPI.secretary.contactUnbind(secretaryId))}
              >
                <Unlink className="size-3.5" />
                {t('Unbind')}
              </button>
              <button
                type="button"
                data-enso="secretary-contact-replace"
                disabled={busy}
                className={BUTTON_CLASS}
                onClick={() =>
                  run(() => window.electronAPI.secretary.contactForgetBot(secretaryId))
                }
              >
                <RefreshCw className="size-3.5" />
                {t('Change bot')}
              </button>
            </div>
          </div>
          {groupsStep}
          <div
            data-enso="secretary-contact-sync"
            className={cn(SUB_PAD, telegram.syncMirror && 'border-warning/50 bg-warning/5')}
          >
            {telegram.syncMirror ? (
              <>
                <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-warning">
                  <RadioTower className="size-3.5 shrink-0" />
                  {t('Mirroring every conversation to Telegram')}
                </div>
                <p className="mt-1 text-[11.5px] text-muted-foreground">
                  {t(
                    'Every reply in the secretary conversation is sent to your phone, not just milestones. Silent turns stay quiet. Telegram messages are not end-to-end encrypted and stay on Telegram servers. Send /sync off in Telegram to stop.'
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
          <div data-enso="secretary-contact-commands" className={SUB_PAD}>
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
            <p className={cn(SUB_PAD, 'text-[11.5px] text-warning')}>
              {t(
                'No system keychain available: the bot token is stored unencrypted on this machine.'
              )}
            </p>
          )}
        </>
      )}
      {telegram.status === 'awaiting-start' && (
        <>
          <div data-enso="secretary-contact-verified" className={SUB_PAD}>
            <StepHead index={2} label={t('Bot verified')} />
            <p className="mt-1 text-[13px] font-medium">
              {telegram.bot?.name}{' '}
              <span className="text-muted-foreground">@{telegram.bot?.username}</span>
            </p>
          </div>
          <div data-enso="secretary-contact-code" className={SUB_PAD}>
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
                {expired ? (
                  <p
                    data-enso="secretary-contact-code-expired"
                    className="mt-1 text-[11.5px] text-warning"
                  >
                    {t('This code has expired')}
                  </p>
                ) : (
                  <p className="mt-1 text-[11.5px] text-subtle-foreground">
                    {t('Valid for {{minutes}} more minutes', { minutes })}
                  </p>
                )}
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
                className={expired ? PRIMARY_CLASS : BUTTON_CLASS}
                onClick={() =>
                  run(() => window.electronAPI.secretary.contactBind(undefined, secretaryId))
                }
              >
                <RefreshCw className="size-3.5" />
                {t('New code')}
              </button>
              <button
                type="button"
                data-enso="secretary-contact-cancel"
                disabled={busy}
                className={BUTTON_CLASS}
                onClick={() => run(() => window.electronAPI.secretary.contactCancel(secretaryId))}
              >
                {t('Cancel')}
              </button>
            </div>
            {telegram.bind && <SecretaryContactBindRejection bind={telegram.bind} />}
            {privateOwner && telegram.bind?.rejected?.reason !== 'private-owned' && (
              <p
                data-enso="secretary-contact-private-owned"
                className="mt-2 text-[11.5px] text-warning"
              >
                {t(
                  'Your private chat with this bot already belongs to secretary "{{owner}}". Bind this secretary to a group or forum topic instead.',
                  { owner: privateOwner }
                )}
              </p>
            )}
            <p className="mt-2 text-[11.5px] text-subtle-foreground">
              {t(
                'The code works once. Press Start in a private chat with the bot, or send it in a group or forum topic to bind that place to this secretary instead.'
              )}
            </p>
          </div>
          {groupsStep}
        </>
      )}
      {telegram.shared && telegram.status !== 'unbound' && (
        <SecretaryContactSharedBot shared={telegram.shared} bot={telegram.bot?.username} />
      )}
      {telegram.status === 'unbound' && (
        <>
          <div data-enso="secretary-contact-step1" className={SUB_PAD}>
            <StepHead index={1} label={t('Create a bot with @BotFather')} />
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              {t('Send /newbot, pick a name, and copy the token it gives you.')}
            </p>
            <a
              data-enso="secretary-contact-botfather"
              href={BOTFATHER_URL}
              target="_blank"
              rel="noreferrer"
              className={cn(LINK_CLASS, 'mt-2')}
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
              onClick={() =>
                run(() => window.electronAPI.secretary.contactBind(token.trim(), secretaryId))
              }
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
                onClick={() =>
                  run(() => window.electronAPI.secretary.contactBind(undefined, secretaryId))
                }
              >
                <RefreshCw className="size-3.5" />
                {t('Bind again with @{{bot}}', { bot: telegram.bot.username })}
              </button>
            )}
          </div>
          <p className={cn(SUB_PAD, 'text-[11.5px] text-subtle-foreground')}>
            {t('The token is stored with the system keychain and never written to logs.')}
          </p>
          {groupsStep}
        </>
      )}
    </>
  );

  const setEnabled = (checked: boolean) =>
    run(() => window.electronAPI.secretary.contactSettings({ enabled: checked }, secretaryId));
  // 总开关管的是各渠道收发：设置页放在「联系渠道」组顶部
  const masterSwitch = (
    <div data-enso="secretary-contact-master">
      <SettingsRow rowId="contacts.enable-contacts" label={t('Enable contacts')}>
        <EnableSwitch
          checked={state.enabled}
          disabled={busy}
          label={t('Enable contacts')}
          onCheckedChange={setEnabled}
        />
      </SettingsRow>
    </div>
  );
  const ownerBlock = (
    <OwnerIdentity
      owner={state.owner}
      secretaryId={secretaryId}
      busy={busy}
      error={error}
      run={run}
    />
  );
  const channelsBlock = !state.enabled ? (
    <div className="px-4 py-3 text-[13px] text-muted-foreground max-sm:px-3">
      {t('Contacts are off: nothing is sent or received on any channel.')}
    </div>
  ) : (
    <>
      {(shownError || pollFailed) && (
        <div
          data-enso="secretary-contact-error"
          className="flex items-start gap-1.5 border-destructive border-l-2 bg-destructive/5 px-4 py-2.5 text-[12px] text-destructive max-sm:px-3"
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {shownError
              ? t(ERROR_TEXT[shownError] ?? 'Telegram returned an error')
              : t('Cannot reach api.telegram.org. Check the proxy.')}
          </span>
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-1.5 border-success border-l-2 bg-success/5 px-4 py-2.5 text-[12px] text-success max-sm:px-3">
          <Check className="size-3.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {channels.map((channel) => (
        <ChannelCard
          key={channel.id}
          channel={channel}
          collapsed={collapsed[channel.id] === true}
          busy={busy}
          onToggle={() => toggleCollapsed(channel.id)}
          onPrefs={(prefs) => setPrefs(channel.id, prefs)}
          onRetry={() => retryChannel(channel.id)}
        >
          {channel.id === 'telegram' ? (
            telegramBody
          ) : channel.pluginId && channel.settingsView ? (
            <div data-enso="secretary-contact-plugin-view" className="h-72 overflow-hidden">
              <PluginFrame
                pluginId={channel.pluginId}
                entry={channel.settingsView}
                title={channel.title}
                sessionId={null}
              />
            </div>
          ) : null}
        </ChannelCard>
      ))}

      <div data-enso="secretary-contact-following" className={SUB_PAD}>
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12.5px] font-medium">
            {t('Followed from the phone: {{count}}', { count: telegram.following.length })}
          </div>
          {telegram.following.length > 0 && (
            <button
              type="button"
              data-enso="secretary-contact-following-clear"
              disabled={busy}
              className={BUTTON_CLASS}
              onClick={() =>
                run(() =>
                  window.electronAPI.secretary.contactFollowing({ action: 'clear' }, secretaryId)
                )
              }
            >
              {t('Clear all')}
            </button>
          )}
        </div>
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          {t(
            'What you dispatch or schedule from the phone keeps reporting here until it finishes or fails once, even with /sync off.'
          )}
        </p>
        {telegram.following.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-1">
            {telegram.following.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1 text-[12px]">
                  <span className="text-muted-foreground">
                    {item.kind === 'schedule' ? t('Scheduled') : t('Session')} ·{' '}
                  </span>
                  {item.summary}
                </span>
                <button
                  type="button"
                  data-enso="secretary-contact-following-cancel"
                  disabled={busy}
                  className={BUTTON_CLASS}
                  onClick={() =>
                    run(() =>
                      window.electronAPI.secretary.contactFollowing(
                        {
                          action: 'cancel',
                          id: item.id,
                        },
                        secretaryId
                      )
                    )
                  }
                >
                  {t('Drop')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <SettingsRow
        interactive
        rowId="contacts.plugin-market"
        label={
          <button
            type="button"
            data-enso="secretary-contact-market"
            className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
            onClick={() =>
              openSettings({
                category: 'plugins',
                rowId: 'plugins.enso',
                marketQuery: 'contact',
              })
            }
          >
            {t('Find more contact channels in the plugin market')}
          </button>
        }
        leading={<Search className="size-4 shrink-0 text-muted-foreground" />}
      />
    </>
  );

  return (
    <div data-enso="secretary-contact">
      {frames.owner(ownerBlock)}
      {frames.channels(
        <>
          {masterSwitch}
          {channelsBlock}
        </>
      )}
    </div>
  );
}
