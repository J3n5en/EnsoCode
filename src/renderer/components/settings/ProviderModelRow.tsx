import { applyModelOverrides, modelRowBadge } from '@shared/modelEntry';
import type { ModelEntry, ThinkingLevel } from '@shared/types';
import { THINKING_LEVELS } from '@shared/types';
import { ChevronDown, Trash2 } from 'lucide-react';
import type * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';

const isEnabled = (model: ModelEntry) => model.enabled !== false;

const LEVEL_LABEL_KEYS: Record<ThinkingLevel, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  max: 'Max',
};

const BADGE_LABEL_KEYS = {
  override: 'Overridden',
  catalog: 'Catalog',
  default: 'Default',
  inherit: 'Inherit',
} as const;

const BADGE_VARIANTS = {
  override: 'secondary',
  catalog: 'outline',
  default: 'outline',
  inherit: 'outline',
} as const;

interface ProviderModelRowProps {
  model: ModelEntry;
  expanded: boolean;
  /** OAuth 订阅行只读 catalog，不展开、不写覆盖 */
  canOverride: boolean;
  catalogMatched?: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: () => void;
  onRemove: () => void;
  onChange: (next: ModelEntry) => void;
}

export function ProviderModelRow({
  model,
  expanded,
  canOverride,
  catalogMatched,
  onToggleExpand,
  onToggleEnabled,
  onRemove,
  onChange,
}: ProviderModelRowProps) {
  const { t } = useI18n();
  const badge = modelRowBadge(model, catalogMatched);
  const showEditors = canOverride && expanded;

  const patch = (updates: Parameters<typeof applyModelOverrides>[1]) => {
    onChange(applyModelOverrides(model, updates));
  };

  return (
    <div
      data-slot="provider-model-row"
      data-model-id={model.id}
      data-expanded={showEditors ? 'true' : 'false'}
      data-can-override={canOverride ? 'true' : 'false'}
      data-override-source={badge}
      className="rounded-md"
    >
      <div className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50">
        <Switch checked={isEnabled(model)} onCheckedChange={onToggleEnabled} />
        {canOverride ? (
          <button
            type="button"
            data-slot="model-row-toggle"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={onToggleExpand}
          >
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                showEditors && 'rotate-180'
              )}
            />
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-mono text-xs',
                !isEnabled(model) && 'text-muted-foreground line-through'
              )}
            >
              {model.id}
            </span>
            <Badge
              variant={BADGE_VARIANTS[badge]}
              size="sm"
              data-slot="model-override-badge"
              className="shrink-0 text-[10px]"
            >
              {t(BADGE_LABEL_KEYS[badge])}
            </Badge>
          </button>
        ) : (
          <span
            className={cn(
              'min-w-0 flex-1 truncate font-mono text-xs',
              !isEnabled(model) && 'text-muted-foreground line-through'
            )}
          >
            {model.id}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {showEditors && (
        <div
          data-slot="model-override-editors"
          className="mb-1 ml-8 space-y-2 rounded-md border border-dashed bg-muted/30 p-2"
        >
          <OverrideField label={t('Reasoning')}>
            <TriState
              slot="model-reasoning"
              value={model.reasoning}
              onChange={(reasoning) => patch({ reasoning })}
              onLabel={t('On')}
              offLabel={t('Off')}
              inheritLabel={t('Inherit')}
            />
          </OverrideField>

          {model.reasoning === true && (
            <OverrideField label={t('Thinking level')}>
              <Select
                items={[
                  { value: 'inherit', label: t('Inherit') },
                  ...THINKING_LEVELS.map((level) => ({
                    value: level,
                    label: t(LEVEL_LABEL_KEYS[level]),
                  })),
                ]}
                value={model.thinkingLevel ?? 'inherit'}
                onValueChange={(value) => {
                  const next =
                    value && value !== 'inherit' && isThinkingLevel(value) ? value : undefined;
                  patch({ thinkingLevel: next });
                }}
              >
                <SelectTrigger
                  size="sm"
                  data-slot="model-thinking-level"
                  className="h-7 min-h-7 w-full min-w-0 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                  <SelectItem value="inherit">{t('Inherit')}</SelectItem>
                  {THINKING_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {t(LEVEL_LABEL_KEYS[level])}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </OverrideField>
          )}

          <div className="grid grid-cols-2 gap-2">
            <OverrideField label={t('Context')}>
              <InheritNumberInput
                slot="model-context"
                value={model.contextWindow}
                onChange={(contextWindow) => patch({ contextWindow })}
                inheritLabel={t('Inherit')}
              />
            </OverrideField>
            <OverrideField label={t('Max tokens')}>
              <InheritNumberInput
                slot="model-max-tokens"
                value={model.maxTokens}
                onChange={(maxTokens) => patch({ maxTokens })}
                inheritLabel={t('Inherit')}
              />
            </OverrideField>
          </div>
        </div>
      )}
    </div>
  );
}

function OverrideField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex w-full flex-col items-stretch gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function TriState({
  slot,
  value,
  onChange,
  onLabel,
  offLabel,
  inheritLabel,
}: {
  slot: string;
  value: boolean | undefined;
  onChange: (next: boolean | undefined) => void;
  onLabel: string;
  offLabel: string;
  inheritLabel: string;
}) {
  const options = [
    { key: 'on', value: true, label: onLabel },
    { key: 'off', value: false, label: offLabel },
    { key: 'inherit', value: undefined, label: inheritLabel },
  ] as const;

  return (
    <div data-slot={slot} className="flex w-full rounded-md border bg-background p-0.5">
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.key}
            type="button"
            data-slot={`${slot}-option`}
            data-value={option.key}
            data-selected={selected ? 'true' : 'false'}
            className={cn(
              'h-6 flex-1 rounded-sm px-1.5 text-[11px]',
              selected
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function InheritNumberInput({
  slot,
  value,
  onChange,
  inheritLabel,
}: {
  slot: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  inheritLabel: string;
}) {
  return (
    <Input
      type="number"
      min={1}
      inputMode="numeric"
      data-slot={slot}
      value={value === undefined ? '' : String(value)}
      placeholder={inheritLabel}
      className="h-7 text-xs"
      onChange={(event) => {
        const raw = event.target.value;
        if (raw.trim() === '') {
          onChange(undefined);
          return;
        }
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) onChange(Math.floor(parsed));
      }}
    />
  );
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}
