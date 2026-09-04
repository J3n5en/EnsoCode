import { type ModelPricing, parseUsageModelPricing } from '@shared/usage/pricing';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';

const EMPTY: ModelPricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function toDraft(p: ModelPricing): Record<(typeof FIELDS)[number], string> {
  return {
    input: String(p.input),
    output: String(p.output),
    cacheRead: String(p.cacheRead),
    cacheWrite: String(p.cacheWrite),
  };
}

function fromDraft(draft: Record<(typeof FIELDS)[number], string>): ModelPricing | null {
  const parsed = parseUsageModelPricing({
    id: Object.fromEntries(FIELDS.map((key) => [key, Number(draft[key])])),
  });
  return parsed.id ?? null;
}

export function UsagePricingEditor({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n();
  const pricing = useSettingsStore((s) => s.usageModelPricing);
  const setPricing = useSettingsStore((s) => s.setUsageModelPricing);
  const removePricing = useSettingsStore((s) => s.removeUsageModelPricing);
  const [modelId, setModelId] = React.useState('');
  const [draft, setDraft] = React.useState(toDraft(EMPTY));
  const [error, setError] = React.useState<string | null>(null);
  const ids = Object.keys(pricing).sort();

  const save = (id: string, next: ModelPricing | null): boolean => {
    if (!next || !setPricing(id, next)) {
      setError(t('Enter a model id and non-negative rates.'));
      return false;
    }
    setError(null);
    onChanged();
    return true;
  };

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3">
        <div className="text-sm font-medium">{t('Unit prices')}</div>
        <p className="text-xs text-muted-foreground">
          {t('Override catalog rates ($/M tokens). Exact model id; empty rate is 0.')}
        </p>
      </div>

      {ids.length > 0 && (
        <div className="mb-3 space-y-2">
          {ids.map((id) => (
            <div key={id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={id}>
                {id}
              </span>
              {FIELDS.map((field) => (
                <span key={field} className="font-mono text-[11px] text-muted-foreground">
                  {field} {pricing[id][field]}
                </span>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => {
                  removePricing(id);
                  onChanged();
                }}
              >
                {t('Remove')}
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('Model id')}>
          <Input
            size="sm"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder="qwen-3.8-27b"
          />
        </Field>
        {FIELDS.map((field) => (
          <Field key={field} label={field}>
            <Input
              size="sm"
              inputMode="decimal"
              value={draft[field]}
              onChange={(e) => setDraft((cur) => ({ ...cur, [field]: e.target.value }))}
            />
          </Field>
        ))}
        <Button
          size="sm"
          className="h-7"
          onClick={() => {
            if (save(modelId, fromDraft(draft))) {
              setModelId('');
              setDraft(toDraft(EMPTY));
            }
          }}
        >
          {t('Save')}
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid min-w-24 gap-1 text-[11px] text-muted-foreground">
      {label}
      {children}
    </label>
  );
}
