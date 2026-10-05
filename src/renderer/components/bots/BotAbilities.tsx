import {
  type AbilityChange,
  type AbilityField,
  type AbilitySuggestion,
  type AbilityValues,
  abilityChanges,
  applyAbilityChanges,
} from '@shared/bots/abilitySuggest';
import type { BotList, BotProfile } from '@shared/types/bot';
import type { BotAbilitySuggestResult } from '@shared/types/botIpc';
import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { APPROVAL_MODE_META } from '@/components/chat/ApprovalModePicker';
import { DetailRows, PickList, setFilteredIds } from '@/components/settings/PresetsSettings';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { addToast } from '@/components/ui/toast';
import { type TFunction, useI18n } from '@/i18n';
import { useBotsStore } from '@/stores/bots';
import type { BudgetForm, LimitsForm } from '@/stores/bots/budget';
import { useSettingsStore } from '@/stores/settings';
import { BotAvatar } from './BotAvatar';
import { ApprovalSelect, FieldLabel, Segmented } from './BotFields';

/** 成员能力（模型除外）：新建对话框与资料面板共用 */
export interface AbilityForm extends AbilityValues, BudgetForm, LimitsForm {
  memoryEnabled: boolean;
}

export const DEFAULT_ABILITIES: AbilityForm = {
  tools: 'all',
  approvalMode: 'auto-edits',
  skillIds: [],
  mcpServerIds: [],
  canDelegateTo: 'any',
  acceptFrom: 'any',
  memoryEnabled: true,
  budgetCost: '',
  budgetTokens: '',
  delegationTimeout: '',
  maxTurnTokens: '',
};

export interface AbilityProfile {
  name: string;
  title: string;
  scope: string;
  persona: string;
}

export function BotAbilityFields({
  value,
  onChange,
  profile,
  botId,
  zIndex,
}: {
  value: AbilityForm;
  onChange: (next: Partial<AbilityForm>) => void;
  /** 「自动设置能力」依据的成员描述 */
  profile: AbilityProfile;
  /** 已有成员：委派候选排除自己 */
  botId?: string;
  zIndex?: number;
}) {
  const { t } = useI18n();
  const bots = useBotsStore((s) => s.bots);
  const others = bots.filter((item) => item.id !== botId && !item.archivedAt);
  return (
    <div className="space-y-4">
      <AutoAbilities value={value} onApply={onChange} profile={profile} botId={botId} />
      <div>
        <FieldLabel>{t('Tools')}</FieldLabel>
        <Segmented
          value={value.tools}
          options={[
            { value: 'all', label: t('All tools') },
            { value: 'readonly', label: t('Read-only') },
          ]}
          onChange={(tools) => onChange({ tools })}
        />
      </div>
      <div>
        <FieldLabel>{t('Approval mode')}</FieldLabel>
        <ApprovalSelect
          value={value.approvalMode}
          onChange={(approvalMode) => onChange({ approvalMode })}
          zIndex={zIndex}
        />
      </div>
      <AssetPickers value={value} onChange={onChange} />
      <DelegationField
        label={t('Can delegate to')}
        value={value.canDelegateTo}
        bots={others}
        onChange={(canDelegateTo) => onChange({ canDelegateTo })}
      />
      <DelegationField
        label={t('Accepts delegation from')}
        value={value.acceptFrom}
        bots={others}
        onChange={(acceptFrom) => onChange({ acceptFrom })}
      />
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>{t('Long-term memory')}</span>
        <Switch
          checked={value.memoryEnabled}
          onCheckedChange={(memoryEnabled) => onChange({ memoryEnabled })}
        />
      </label>
      <div>
        <FieldLabel>{t('Daily budget')}</FieldLabel>
        <div className="grid grid-cols-2 gap-2">
          <Input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={value.budgetCost}
            placeholder={t('Cost (USD), empty = unlimited')}
            aria-label={t('Daily cost limit (USD)')}
            onChange={(event) => onChange({ budgetCost: event.target.value })}
          />
          <Input
            type="number"
            min={0}
            step="1"
            inputMode="numeric"
            value={value.budgetTokens}
            placeholder={t('Tokens, empty = unlimited')}
            aria-label={t('Daily token limit')}
            onChange={(event) => onChange({ budgetTokens: event.target.value })}
          />
        </div>
        <p className="mt-1 text-muted-foreground text-xs">
          {t(
            'Resets at local midnight. Once reached, new messages to this member are refused and a running reply is stopped.'
          )}
        </p>
      </div>
      <div>
        <FieldLabel>{t('Per-turn token limit')}</FieldLabel>
        <Input
          type="number"
          min={1}
          step="1"
          inputMode="numeric"
          value={value.maxTurnTokens}
          placeholder={t('Tokens, empty = unlimited')}
          aria-label={t('Per-turn token limit')}
          onChange={(event) => onChange({ maxTurnTokens: event.target.value })}
        />
        <p className="mt-1 text-muted-foreground text-xs">
          {t(
            'A single reply that uses more tokens than this (counted while streaming) is stopped.'
          )}
        </p>
      </div>
      <div>
        <FieldLabel>{t('Delegation time limit (minutes)')}</FieldLabel>
        <Input
          type="number"
          min={1}
          max={1440}
          step="1"
          inputMode="numeric"
          value={value.delegationTimeout}
          placeholder={t('Empty = 240')}
          aria-label={t('Delegation time limit (minutes)')}
          onChange={(event) => onChange({ delegationTimeout: event.target.value })}
        />
        <p className="mt-1 text-muted-foreground text-xs">
          {t(
            'When other members delegate to this one, the task fails with a timeout after this long. A delegator can ask for less, not more.'
          )}
        </p>
      </div>
    </div>
  );
}

export function suggestErrorText(
  result: Extract<BotAbilitySuggestResult, { ok: false }>,
  t: TFunction
) {
  switch (result.error) {
    case 'no-model':
      return t('No model is available. Set a default model or a Bot assistant model first.');
    case 'timeout':
      return t('The model did not answer in time. Try again.');
    case 'invalid-reply':
      return t('The model reply could not be understood. Try again.');
    case 'invalid':
      return t('Fill in a name, title or responsibilities first.');
    default:
      return t('Could not get suggestions');
  }
}

/** 推荐只进表单：逐项勾选后「应用」，仍需用户保存 / 创建 */
function AutoAbilities({
  value,
  onApply,
  profile,
  botId,
}: {
  value: AbilityForm;
  onApply: (next: Partial<AbilityForm>) => void;
  profile: AbilityProfile;
  botId?: string;
}) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<AbilitySuggestion | null>(null);
  const [skipped, setSkipped] = useState<AbilityField[]>([]);
  const changes = suggestion ? abilityChanges(value, suggestion) : [];

  const run = async () => {
    if (![profile.name, profile.title, profile.scope, profile.persona].some((s) => s.trim())) {
      addToast({ type: 'warning', title: t('Fill in a name, title or responsibilities first.') });
      return;
    }
    setBusy(true);
    try {
      const result = await window.electronAPI.bots.suggestAbilities({
        name: profile.name,
        title: profile.title,
        scope: profile.scope,
        persona: profile.persona,
        language: locale === 'zh' ? 'zh' : 'en',
        ...(botId ? { botId } : {}),
      });
      if (!result.ok) {
        addToast({
          type: 'error',
          title: suggestErrorText(result, t),
          ...(result.detail ? { description: result.detail } : {}),
        });
        return;
      }
      if (abilityChanges(value, result.suggestion).length === 0) {
        addToast({ type: 'info', title: t('Current abilities already match the suggestion.') });
        return;
      }
      setSkipped([]);
      setSuggestion(result.suggestion);
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    const fields = changes.map((change) => change.field).filter((f) => !skipped.includes(f));
    const next = applyAbilityChanges(value, changes, fields);
    onApply(Object.fromEntries(fields.map((field) => [field, next[field]])));
    setSuggestion(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {t('Let a model suggest abilities from the name, title, responsibilities and persona.')}
        </span>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void run()}>
          {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {t('Auto-configure abilities')}
        </Button>
      </div>
      {suggestion && changes.length > 0 && (
        <div className="space-y-2 rounded-lg border bg-muted/40 p-2.5">
          <p className="font-medium text-xs">{t('Suggested changes')}</p>
          {changes.map((change) => (
            <label key={change.field} className="flex items-start gap-2 text-xs">
              <Checkbox
                className="mt-0.5"
                checked={!skipped.includes(change.field)}
                onCheckedChange={(checked) =>
                  setSkipped((list) =>
                    checked ? list.filter((f) => f !== change.field) : [...list, change.field]
                  )
                }
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="font-medium">{fieldLabel(change.field, t)}</span>
                  <ChangeValue change={change} />
                </div>
                {change.reason && <p className="text-muted-foreground">{change.reason}</p>}
              </div>
            </label>
          ))}
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="outline" onClick={() => setSuggestion(null)}>
              {t('Cancel')}
            </Button>
            <Button
              size="xs"
              disabled={changes.every((change) => skipped.includes(change.field))}
              onClick={apply}
            >
              {t('Apply')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function fieldLabel(field: AbilityField, t: TFunction): string {
  switch (field) {
    case 'tools':
      return t('Tools');
    case 'approvalMode':
      return t('Approval mode');
    case 'skillIds':
      return t('Skills');
    case 'mcpServerIds':
      return t('MCP Servers');
    case 'canDelegateTo':
      return t('Can delegate to');
    case 'acceptFrom':
      return t('Accepts delegation from');
  }
}

function ChangeValue({ change }: { change: AbilityChange }) {
  const { t } = useI18n();
  const skills = useSettingsStore((s) => s.skills);
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const bots = useBotsStore((s) => s.bots);
  const scalar = (from: string, to: string) => (
    <span className="text-muted-foreground">
      {from} → <span className="text-foreground">{to}</span>
    </span>
  );
  if (change.field === 'tools') {
    const label = (v: BotProfile['tools']) => (v === 'all' ? t('All tools') : t('Read-only'));
    return scalar(label(change.from), label(change.to));
  }
  if (change.field === 'approvalMode') {
    const label = (v: typeof change.from) => t(APPROVAL_MODE_META[v].labelKey);
    return scalar(label(change.from), label(change.to));
  }
  const items: readonly { id: string; name: string }[] =
    change.field === 'skillIds' ? skills : change.field === 'mcpServerIds' ? mcpServers : bots;
  const name = (id: string) => items.find((item) => item.id === id)?.name ?? id;
  const from: BotList = change.from;
  const to: BotList = change.to;
  if (from === 'any' || to === 'any') {
    const label = (v: BotList) =>
      v === 'any' ? t('All members') : v.length === 0 ? t('None selected') : v.map(name).join(', ');
    return scalar(label(from), label(to));
  }
  const added = to.filter((id) => !from.includes(id));
  const removed = from.filter((id) => !to.includes(id));
  return (
    <span className="space-x-1.5">
      {added.map((id) => (
        <span key={`+${id}`} className="text-success">
          +{name(id)}
        </span>
      ))}
      {removed.map((id) => (
        <span key={`-${id}`} className="text-destructive line-through">
          {name(id)}
        </span>
      ))}
    </span>
  );
}

type AssetValue = Pick<AbilityForm, 'skillIds' | 'mcpServerIds'>;

export function AssetPickers({
  value,
  onChange,
}: {
  value: AssetValue;
  onChange: (next: Partial<AssetValue>) => void;
}) {
  const { t } = useI18n();
  const skills = useSettingsStore((s) => s.skills);
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  return (
    <>
      <PickList
        title={t('Skills')}
        emptyText={t('No skills yet')}
        items={skills}
        getName={(skill) => skill.name}
        getSource={(skill) => skill.source}
        isChecked={(skill) => value.skillIds.includes(skill.id)}
        onToggle={(skill) => onChange({ skillIds: toggle(value.skillIds, skill.id) })}
        onSetFiltered={(ids, selected) =>
          onChange({ skillIds: setFilteredIds(value.skillIds, ids, selected) })
        }
        placeholder={t('Filter skills...')}
        renderDetail={(skill) => (
          <DetailRows
            rows={[
              [t('Source'), skill.source],
              [t('Path'), skill.path],
              [t('Description'), skill.description],
            ]}
          />
        )}
      />
      <PickList
        title={t('MCP Servers')}
        emptyText={t('No MCP servers yet')}
        items={mcpServers}
        getName={(server) => server.name}
        getSource={(server) => server.source}
        isChecked={(server) => value.mcpServerIds.includes(server.id)}
        onToggle={(server) => onChange({ mcpServerIds: toggle(value.mcpServerIds, server.id) })}
        onSetFiltered={(ids, selected) =>
          onChange({ mcpServerIds: setFilteredIds(value.mcpServerIds, ids, selected) })
        }
        placeholder={t('Filter MCP servers...')}
        renderDetail={(server) => (
          <DetailRows
            rows={[
              [t('Source'), server.source],
              ['Transport', server.transport],
              ['URL', server.url],
            ]}
          />
        )}
      />
    </>
  );
}

function DelegationField({
  label,
  value,
  bots,
  onChange,
}: {
  label: string;
  value: BotList;
  bots: BotProfile[];
  onChange: (value: BotList) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <Segmented
        value={value === 'any' ? 'any' : 'some'}
        options={[
          { value: 'any', label: t('All members') },
          { value: 'some', label: t('Selected members') },
        ]}
        onChange={(mode) => onChange(mode === 'any' ? 'any' : [])}
      />
      {value !== 'any' && (
        <div className="mt-1.5 space-y-1">
          {bots.length === 0 && (
            <p className="text-muted-foreground text-xs">{t('No other members')}</p>
          )}
          {bots.map((bot) => (
            <label key={bot.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={value.includes(bot.id)}
                onCheckedChange={(checked) =>
                  onChange(checked ? [...value, bot.id] : value.filter((id) => id !== bot.id))
                }
              />
              <BotAvatar bot={bot} size="xs" />
              {bot.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
