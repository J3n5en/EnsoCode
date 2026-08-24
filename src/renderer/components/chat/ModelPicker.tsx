import type { ModelProvider } from '@shared/types';
import { THINKING_LEVELS, type ThinkingLevel } from '@shared/types/agent';
import { Brain, Check, ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  max: 'Max',
};

interface ModelPickerProps {
  providers: ModelProvider[];
  providerId: string;
  modelId: string;
  reasoningEnabled: boolean;
  thinkingLevel: ThinkingLevel;
  /** reasoning 开关切换后需重开会话生效时为 true（用于提示） */
  reasoningNeedsRestart: boolean;
  onSelect: (providerId: string, modelId: string) => void;
  onReasoningChange: (enabled: boolean) => void;
  onThinkingChange: (level: ThinkingLevel) => void;
}

/** composer 工具行的模型选择：pill 触发 + 搜索 + provider 分组 + 推理开关 + 档位滑块 */
export function ModelPicker({
  providers,
  providerId,
  modelId,
  reasoningEnabled,
  thinkingLevel,
  reasoningNeedsRestart,
  onSelect,
  onReasoningChange,
  onThinkingChange,
}: ModelPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');

  const groups = useMemo(
    () =>
      providers
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          models: (provider.models ?? []).filter(
            (model) =>
              model.enabled !== false &&
              (!keyword ||
                model.id.toLowerCase().includes(keyword.toLowerCase()) ||
                (model.label ?? '').toLowerCase().includes(keyword.toLowerCase()))
          ),
        }))
        .filter((group) => group.models.length > 0),
    [providers, keyword]
  );

  const current = providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId);
  const levelIndex = Math.max(0, THINKING_LEVELS.indexOf(thinkingLevel));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex h-7 max-w-64 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
        <span className="truncate">{current?.label ?? modelId ?? t('Model')}</span>
        {reasoningEnabled && (
          <span className="flex shrink-0 items-center gap-0.5 text-primary">
            <Brain className="h-3 w-3" />
            {LEVEL_LABELS[thinkingLevel]}
          </span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-80 p-0">
        <div className="border-b p-2">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t('Search models')}
            className="h-8 w-full rounded-md border bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-2">
          {groups.map((group) => (
            <div key={group.id} className="mb-2 last:mb-0">
              <p className="px-1 pb-1 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                {group.name}
              </p>
              <div className="flex flex-col gap-0.5">
                {group.models.map((model) => {
                  const selected = group.id === providerId && model.id === modelId;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => {
                        onSelect(group.id, model.id);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                        selected
                          ? 'bg-primary/10 text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{model.label ?? model.id}</span>
                      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {groups.length === 0 && (
            <p className="px-1 py-4 text-center text-xs text-muted-foreground">
              {t('No models found')}
            </p>
          )}
        </div>

        <div className="border-t p-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-xs">
              <Brain className="h-3.5 w-3.5 text-muted-foreground" />
              {t('Reasoning')}
            </span>
            <Switch checked={reasoningEnabled} onCheckedChange={onReasoningChange} />
          </div>

          {reasoningEnabled && (
            <div className="mt-3">
              <Slider
                min={0}
                max={THINKING_LEVELS.length - 1}
                step={1}
                value={levelIndex}
                onValueChange={(value) => {
                  const index = Array.isArray(value) ? value[0] : value;
                  onThinkingChange(THINKING_LEVELS[index] ?? 'medium');
                }}
              />
              <div className="mt-1.5 flex justify-between">
                {THINKING_LEVELS.map((entry, index) => (
                  <button
                    key={entry}
                    type="button"
                    onClick={() => onThinkingChange(entry)}
                    className={cn(
                      'flex w-8 flex-col items-center gap-0.5',
                      index === 0 && 'items-start',
                      index === THINKING_LEVELS.length - 1 && 'items-end'
                    )}
                  >
                    <span className="h-1.5 w-px bg-muted-foreground/40" />
                    <span
                      className={cn(
                        'text-[10px] transition-colors',
                        entry === thinkingLevel
                          ? 'font-medium text-primary'
                          : 'text-muted-foreground/70 hover:text-foreground'
                      )}
                    >
                      {LEVEL_LABELS[entry]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {reasoningNeedsRestart && (
            <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-500">
              {t('Takes effect in a new conversation')}
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
