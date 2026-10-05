import type { TeamRefList } from '@shared/bots/team';
import type { ApprovalMode, ThinkingLevel } from '@shared/types/agent';
import { BUILTIN_AGENT_TYPES } from '@shared/types/assets';
import { type BotEngine, type BotProfile, checkBotName } from '@shared/types/bot';
import { Check } from 'lucide-react';
import { useMemo } from 'react';
import { APPROVAL_MODE_META, APPROVAL_MODE_ORDER } from '@/components/chat/ApprovalModePicker';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  usableProvidersForOauthSnapshot,
  useOauthCredentialStore,
} from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';
import { botErrorText } from './botText';

export const AVATAR_PALETTE = [
  '#7c5cff',
  '#0ea5e9',
  '#f97316',
  '#22c55e',
  '#ec4899',
  '#eab308',
  '#14b8a6',
  '#64748b',
];

const RESERVED = BUILTIN_AGENT_TYPES.map((type) => type.name);

/** 本地预检名字（Main 还会按 agent 注册表再校验一次） */
export function nameError(
  name: string,
  bots: readonly Pick<BotProfile, 'id' | 'name'>[],
  t: TFunction,
  selfId?: string
): string | null {
  const result = checkBotName(name, bots, RESERVED, selfId);
  return result.ok ? null : botErrorText(result.reason, '', t);
}

export function FieldLabel({
  children,
  hint,
  action,
}: {
  children: React.ReactNode;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-1 flex items-center justify-between gap-2">
      <span className="text-muted-foreground text-xs">{children}</span>
      {hint && <span className="text-[11px] text-muted-foreground/70">{hint}</span>}
      {action}
    </div>
  );
}

export function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {AVATAR_PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={color}
          onClick={() => onChange(color)}
          className="grid h-6 w-6 place-items-center rounded-full text-white"
          style={{ backgroundColor: color }}
        >
          {value.toLowerCase() === color && <Check className="h-3.5 w-3.5" />}
        </button>
      ))}
      <label
        className="relative grid h-6 w-6 cursor-pointer place-items-center overflow-hidden rounded-full border text-[10px] text-muted-foreground"
        title={t('Custom color')}
      >
        +
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

/** 模型：开关「跟随默认模型」，关闭时选具体模型（engine:null = 跟随） */
export function EngineField({
  engine,
  onChange,
  zIndex,
}: {
  engine: BotEngine | null;
  onChange: (engine: BotEngine | null) => void;
  zIndex?: number;
}) {
  const { t } = useI18n();
  const providers = useSettingsStore((s) => s.providers);
  const defaultModel = useSettingsStore((s) => s.defaultModel);
  const virtualModels = useSettingsStore((s) => s.virtualModels);
  const snapshot = useOauthCredentialStore((s) => s.snapshot);
  const usable = useMemo(
    () => usableProvidersForOauthSnapshot(providers, snapshot),
    [providers, snapshot]
  );
  const follow = engine === null;
  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>{t('Use the default model')}</span>
        <Switch
          checked={follow}
          onCheckedChange={(checked) => {
            if (checked) return onChange(null);
            const fallback = defaultModel ?? {
              providerId: usable[0]?.id ?? '',
              modelId: usable[0]?.models[0]?.id ?? '',
            };
            if (fallback.providerId && fallback.modelId) {
              onChange({ providerId: fallback.providerId, modelId: fallback.modelId });
            }
          }}
        />
      </label>
      {engine && (
        <ModelPicker
          providers={usable}
          virtualModels={virtualModels}
          providerId={engine.providerId}
          modelId={engine.modelId}
          reasoningEnabled={engine.thinkingLevel !== undefined}
          thinkingLevel={engine.thinkingLevel ?? 'medium'}
          onSelect={(providerId, modelId) => onChange({ ...engine, providerId, modelId })}
          onReasoningChange={(enabled) => {
            const { thinkingLevel: _drop, ...rest } = engine;
            onChange(enabled ? { ...rest, thinkingLevel: 'medium' } : rest);
          }}
          onThinkingChange={(level: ThinkingLevel) => onChange({ ...engine, thinkingLevel: level })}
          triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
          zIndex={zIndex}
          side="bottom"
        />
      )}
    </div>
  );
}

export function ApprovalSelect({
  value,
  onChange,
  zIndex,
}: {
  value: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
  zIndex?: number;
}) {
  const { t } = useI18n();
  return (
    <>
      <Select
        items={APPROVAL_MODE_ORDER.map((mode) => ({
          value: mode,
          label: t(APPROVAL_MODE_META[mode].labelKey),
        }))}
        value={value}
        onValueChange={(mode) => onChange(mode as ApprovalMode)}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup zIndex={zIndex}>
          {APPROVAL_MODE_ORDER.map((mode) => (
            <SelectItem key={mode} value={mode}>
              <div>
                <div>{t(APPROVAL_MODE_META[mode].labelKey)}</div>
                <div className="text-muted-foreground text-xs">
                  {t(APPROVAL_MODE_META[mode].descKey)}
                </div>
              </div>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {value === 'full' && (
        <p className="mt-1 text-muted-foreground text-xs">
          {t('Protected actions will not ask for confirmation either.')}
        </p>
      )}
    </>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-lg bg-muted p-0.5 text-xs">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'flex-1 rounded-md px-2 py-1 transition-colors',
            value === option.value
              ? 'bg-background font-medium text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** 团队内委派名单：「全部成员」或勾选的成员 key */
export function TeamRefField({
  label,
  value,
  options,
  nameOf,
  onChange,
}: {
  label: string;
  value: TeamRefList;
  options: string[];
  nameOf: (key: string) => string;
  onChange: (next: TeamRefList) => void;
}) {
  const { t } = useI18n();
  const chip = (active: boolean) =>
    cn(
      'rounded-full border px-2 py-0.5 text-xs transition-colors',
      active ? 'border-info bg-info/10 text-foreground' : 'text-muted-foreground hover:bg-muted'
    );
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className={chip(value === 'any')}
          onClick={() => onChange(value === 'any' ? [] : 'any')}
        >
          {t('All members')}
        </button>
        {options.map((key) => {
          const active = value === 'any' || value.includes(key);
          return (
            <button
              key={key}
              type="button"
              className={chip(value !== 'any' && active)}
              onClick={() =>
                onChange(
                  value === 'any'
                    ? [key]
                    : active
                      ? value.filter((k) => k !== key)
                      : [...value, key]
                )
              }
            >
              {nameOf(key)}
            </button>
          );
        })}
      </div>
      {value !== 'any' && value.length === 0 && (
        <p className="mt-1 text-muted-foreground text-xs">{t('None selected')}</p>
      )}
    </div>
  );
}
