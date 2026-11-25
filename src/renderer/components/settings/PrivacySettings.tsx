import { previewMask } from '@shared/privacyMask/preview';
import { type PrivacyMaskRecord, strongestAction } from '@shared/privacyMask/report';
import {
  type MaskAction,
  PERSONAL_KINDS,
  type PersonalKind,
  type PrivacyMaskSettings,
} from '@shared/privacyMask/settings';
import { RefreshCw } from 'lucide-react';
import * as React from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import {
  SettingsButton,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from './kit';

const ACTION_LABELS: Record<MaskAction, string> = {
  mask: 'Mask',
  warn: 'Warn only',
  block: 'Block',
};
const KIND_LABELS: Record<PersonalKind, string> = {
  email: 'Email',
  phone: 'Phone number',
  idCard: 'ID card number',
  bankCard: 'Bank card number',
  ip: 'IP address',
};
const ACTION_TONE: Record<MaskAction, string> = {
  mask: 'text-info',
  warn: 'text-warning',
  block: 'text-destructive-text',
};
const RANGES = [1, 7, 30] as const;
const RANGE_LABEL: Record<(typeof RANGES)[number], string> = { 1: 'Today', 7: '7D', 30: '30D' };

/** 一次请求里同一个值会出现在多处（用户消息、工具输出、历史回复）：按值合并展示 */
function distinctHits(record: PrivacyMaskRecord): string {
  const byToken = new Map<string, { label: string; count: number }>();
  for (const h of record.report.hits) {
    const prev = byToken.get(h.token);
    if (prev) prev.count += h.count;
    else byToken.set(h.token, { label: `${h.kind} ${h.preview}`, count: h.count });
  }
  return [...byToken.values()]
    .map((v) => (v.count > 1 ? `${v.label} ×${v.count}` : v.label))
    .join(', ');
}

function ActionSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: MaskAction;
  onChange: (value: MaskAction) => void;
}) {
  const { t } = useI18n();
  return (
    <SettingsSelect
      aria-label={label}
      value={value}
      onValueChange={onChange}
      options={(Object.keys(ACTION_LABELS) as MaskAction[]).map((action) => ({
        value: action,
        label: t(ACTION_LABELS[action]),
      }))}
    />
  );
}

/** 每行一项；失焦时提交，避免输入过程中被归一化吃掉换行 */
function ListField({
  label,
  hint,
  value,
  onCommit,
  rowId,
}: {
  label: string;
  hint: string;
  value: string[];
  onCommit: (value: string[]) => void;
  rowId: string;
}) {
  const [draft, setDraft] = React.useState(value.join('\n'));
  React.useEffect(() => setDraft(value.join('\n')), [value]);
  return (
    <div data-settings-row={rowId} className="min-w-0">
      <SettingsRow label={label} description={hint} />
      <div className="px-4 pb-3 max-sm:px-3">
        <Textarea
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommit(draft.split('\n'))}
        />
      </div>
    </div>
  );
}

function TryIt({ settings }: { settings: PrivacyMaskSettings }) {
  const { t } = useI18n();
  const [input, setInput] = React.useState('');
  const result = React.useMemo(() => previewMask(input, settings), [input, settings]);
  return (
    <SettingsSection
      rowId="privacy.try-it"
      title={t('Try it')}
      description={t('Runs locally. Nothing is remembered or sent anywhere.')}
    >
      <div className="min-w-0 px-4 py-3 max-sm:px-3">
        <Textarea
          rows={3}
          value={input}
          placeholder={t('Paste some text, e.g. an .env file')}
          onChange={(e) => setInput(e.target.value)}
        />
        {input && (
          <div className="mt-3 space-y-1">
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-xs">
              {result.text}
            </pre>
            <ul className="space-y-0.5 text-xs">
              {result.report.hits.map((h) => (
                <li key={`${h.token}-${h.action}`} className="flex gap-2">
                  <span className={cn('font-medium', ACTION_TONE[h.action])}>
                    {t(ACTION_LABELS[h.action])}
                  </span>
                  <span>{h.kind}</span>
                  <span className="text-muted-foreground">{h.preview}</span>
                  {h.count > 1 && <span className="text-muted-foreground">×{h.count}</span>}
                </li>
              ))}
              {result.report.hits.length === 0 && (
                <li className="text-muted-foreground">{t('Nothing matched')}</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

function Records() {
  const { t } = useI18n();
  const [days, setDays] = React.useState<(typeof RANGES)[number]>(7);
  const [records, setRecords] = React.useState<PrivacyMaskRecord[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const requestId = React.useRef(0);
  const conversations = useSessionsStore((s) => s.conversations);

  const load = React.useCallback(async (range: (typeof RANGES)[number]) => {
    const id = ++requestId.current;
    setLoading(true);
    const result = await window.electronAPI.privacyMask.records(range).catch(() => []);
    if (id !== requestId.current) return;
    setLoading(false);
    setRecords(result);
  }, []);
  React.useEffect(() => {
    void load(days);
  }, [days, load]);

  const totals = React.useMemo(() => {
    const byAction: Record<MaskAction, number> = { mask: 0, warn: 0, block: 0 };
    const byKind = new Map<string, number>();
    // 按「每次请求的不同值」计数，避免历史上下文里的同一值被反复累加
    for (const r of records ?? []) {
      const seen = new Set<string>();
      for (const h of r.report.hits) {
        const id = `${h.action}:${h.token}`;
        if (seen.has(id)) continue;
        seen.add(id);
        byAction[h.action] += 1;
        byKind.set(h.kind, (byKind.get(h.kind) ?? 0) + 1);
      }
    }
    return { byAction, byKind: [...byKind].sort((a, b) => b[1] - a[1]) };
  }, [records]);

  const sourceLabel = (r: PrivacyMaskRecord) => {
    if (r.source === 'aux') return t('Auxiliary request');
    const title = r.sessionId ? conversations[r.sessionId]?.title : undefined;
    const base = r.source === 'compaction' ? t('Compaction') : t('Session');
    return title ? `${base} · ${title}` : base;
  };

  return (
    <SettingsSection
      rowId="privacy.records"
      title={t('Records')}
      actions={
        <>
          {RANGES.map((r) => (
            <SettingsButton
              key={r}
              variant={r === days ? 'secondary' : 'ghost'}
              onClick={() => setDays(r)}
            >
              {t(RANGE_LABEL[r])}
            </SettingsButton>
          ))}
          <SettingsButton
            variant="ghost"
            onClick={() => void load(days)}
            disabled={loading}
            aria-label={t('Refresh')}
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </SettingsButton>
        </>
      }
    >
      <div className="flex flex-wrap gap-4 px-4 py-3 text-[13px] max-sm:px-3">
        {(Object.keys(ACTION_LABELS) as MaskAction[]).map((a) => (
          <span key={a}>
            <span className={ACTION_TONE[a]}>{t(ACTION_LABELS[a])}</span>{' '}
            <span className="font-medium tabular-nums">{totals.byAction[a]}</span>
          </span>
        ))}
      </div>
      {totals.byKind.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 py-3 text-xs text-muted-foreground max-sm:px-3">
          {totals.byKind.map(([kind, n]) => (
            <span key={kind} className="rounded-md bg-muted px-1.5 py-0.5">
              {kind} {n}
            </span>
          ))}
        </div>
      )}
      <div className="max-h-80 min-w-0 overflow-auto px-4 pb-3 max-sm:px-3">
        <table className="w-max min-w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border/60">
              <th className="py-2 pr-2 font-normal">{t('Requested at')}</th>
              <th className="py-2 pr-2 font-normal">{t('Source')}</th>
              <th className="py-2 pr-2 font-normal">{t('Model')}</th>
              <th className="py-2 font-normal">{t('Hits')}</th>
            </tr>
          </thead>
          <tbody>
            {(records ?? []).slice(0, 200).map((r) => {
              const strongest = strongestAction(r.report);
              const key = `${r.at}:${r.sessionId ?? r.source}:${r.model}:${r.report.hits.map((h) => h.token).join(',')}`;
              return (
                <tr key={key} className="border-b border-border/60 align-top last:border-b-0">
                  <td className="py-2 pr-2 whitespace-nowrap tabular-nums">
                    {new Date(r.at).toLocaleString()}
                  </td>
                  <td className="py-2 pr-2">{sourceLabel(r)}</td>
                  <td className="py-2 pr-2 break-all">{r.model}</td>
                  <td className={cn('py-2', strongest && ACTION_TONE[strongest])}>
                    {distinctHits(r)}
                    {r.report.blocked && ` · ${t('Request blocked')}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {records?.length === 0 && (
          <p className="py-4 text-center text-xs text-muted-foreground">{t('No records yet')}</p>
        )}
      </div>
    </SettingsSection>
  );
}

/** 隐私：发往模型前的本地脱敏规则、试一试与记录 */
export function PrivacySettings() {
  const { t } = useI18n();
  const settings = useSettingsStore((s) => s.privacyMasking);
  const setSettings = useSettingsStore((s) => s.setPrivacyMasking);
  const patch = (next: Partial<PrivacyMaskSettings>) => setSettings({ ...settings, ...next });

  return (
    <SettingsPage
      rowId="privacy.root"
      title={t('Privacy')}
      description={t(
        'Replace API keys and personal data with placeholders before requests leave this device, and restore them in replies. Original values stay in memory on this device only.'
      )}
    >
      <SettingsSection>
        <SettingsRow
          rowId="privacy.enabled"
          label={t('Privacy masking')}
          description={t('Applies to chats, compaction, bot members and helper requests.')}
        >
          <SettingsSwitch
            checked={settings.enabled}
            onCheckedChange={(enabled) => patch({ enabled: enabled === true })}
          />
        </SettingsRow>
      </SettingsSection>
      {settings.enabled && (
        <>
          <SettingsSection
            rowId="privacy.secretsSection"
            title={t('Secrets')}
            description={t('API keys, tokens, private keys, passwords in URLs and config files.')}
            actions={
              <ActionSelect
                label={t('Secrets')}
                value={settings.secrets.action}
                onChange={(action) => patch({ secrets: { ...settings.secrets, action } })}
              />
            }
          >
            <SettingsRow
              rowId="privacy.secrets"
              label={t('Detect secrets')}
              description={t('Recommended. Covers common vendor key formats.')}
            >
              <SettingsSwitch
                checked={settings.secrets.enabled}
                onCheckedChange={(enabled) =>
                  patch({ secrets: { ...settings.secrets, enabled: enabled === true } })
                }
              />
            </SettingsRow>
            <SettingsRow
              rowId="privacy.shape"
              label={t('Send look-alike keys')}
              description={t(
                'Replace keys with fake keys of the same format instead of placeholders, so the model treats them as real keys.'
              )}
            >
              <SettingsSwitch
                checked={settings.secrets.shape}
                onCheckedChange={(shape) =>
                  patch({ secrets: { ...settings.secrets, shape: shape === true } })
                }
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection
            rowId="privacy.personal-data"
            title={t('Personal data')}
            description={t('Emails, phone numbers, ID and bank card numbers, IP addresses.')}
            actions={
              <ActionSelect
                label={t('Personal data')}
                value={settings.personal.action}
                onChange={(action) => patch({ personal: { ...settings.personal, action } })}
              />
            }
          >
            <SettingsRow
              rowId="privacy.personal"
              label={t('Detect personal data')}
              description={t(
                'Matches are validated (checksums, real domains) to limit false hits.'
              )}
            >
              <SettingsSwitch
                checked={settings.personal.enabled}
                onCheckedChange={(enabled) =>
                  patch({ personal: { ...settings.personal, enabled: enabled === true } })
                }
              />
            </SettingsRow>
            {settings.personal.enabled && (
              <div className="flex flex-wrap gap-x-4 gap-y-2 px-4 py-3 max-sm:px-3">
                {PERSONAL_KINDS.map((kind) => (
                  <label key={kind} className="flex items-center gap-1.5 text-[13px]">
                    <Checkbox
                      checked={settings.personal.kinds.includes(kind)}
                      onCheckedChange={(checked) =>
                        patch({
                          personal: {
                            ...settings.personal,
                            kinds: checked
                              ? [...settings.personal.kinds, kind]
                              : settings.personal.kinds.filter((k) => k !== kind),
                          },
                        })
                      }
                    />
                    {t(KIND_LABELS[kind])}
                  </label>
                ))}
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            rowId="privacy.custom-rules"
            title={t('Custom rules')}
            description={t('Words and patterns specific to your work.')}
            actions={
              <ActionSelect
                label={t('Custom rules')}
                value={settings.custom.action}
                onChange={(action) => patch({ custom: { ...settings.custom, action } })}
              />
            }
          >
            <ListField
              rowId="privacy.words"
              label={t('Words')}
              hint={t('One per line, case-insensitive. Project codenames, customer names…')}
              value={settings.custom.words}
              onCommit={(words) => patch({ custom: { ...settings.custom, words } })}
            />
            <ListField
              rowId="privacy.rules"
              label={t('Prefixes or patterns')}
              hint={t('One per line. A prefix like corp_ or a regex like /INC-\\d{4}/i.')}
              value={settings.custom.rules}
              onCommit={(rules) => patch({ custom: { ...settings.custom, rules } })}
            />
          </SettingsSection>

          <SettingsSection rowId="privacy.allow-list" title={t('Allow list')}>
            <ListField
              rowId="privacy.allow"
              label={t('Never mask')}
              hint={t('Exact values, one per line. Team emails, test keys…')}
              value={settings.allow}
              onCommit={(allow) => patch({ allow })}
            />
          </SettingsSection>

          <TryIt settings={settings} />
        </>
      )}
      <Records />
    </SettingsPage>
  );
}
