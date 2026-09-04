import type { ApprovalMode } from '@shared/types/agent';
import { Check, ChevronDown, Shield, ShieldCheck, ShieldOff, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';

const MODE_META: Record<ApprovalMode, { icon: typeof Shield; labelKey: string; descKey: string }> =
  {
    supervised: {
      icon: ShieldCheck,
      labelKey: 'Supervised',
      descKey: 'Approve every command and file change',
    },
    'auto-edits': {
      icon: Shield,
      labelKey: 'Auto-accept edits',
      descKey: 'Edits run freely; commands and MCP still ask',
    },
    full: { icon: ShieldOff, labelKey: 'Full access', descKey: 'Run everything without asking' },
    assistant: {
      icon: Sparkles,
      labelKey: 'Assistant approval',
      descKey: 'A configured model reviews each action first',
    },
  };

const MODES: ApprovalMode[] = ['supervised', 'auto-edits', 'full', 'assistant'];

interface ApprovalModePickerProps {
  mode: ApprovalMode;
  onSelect: (mode: ApprovalMode) => void;
}

/** composer 工具行的审批档位选择（盾牌 pill），会话中途可切换即时生效 */
export function ApprovalModePicker({ mode, onSelect }: ApprovalModePickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const reviewer = useSettingsStore((state) => state.approvalReviewer);
  const providers = useSettingsStore((state) => state.providers);
  const reviewerReady = useMemo(() => {
    if (!reviewer) return false;
    const provider = providers.find(
      (entry) => entry.id === reviewer.providerId && entry.enabled !== false
    );
    return Boolean(
      provider?.models.some((entry) => entry.id === reviewer.modelId && entry.enabled !== false)
    );
  }, [providers, reviewer]);
  const CurrentIcon = MODE_META[mode].icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="flex h-7 min-w-0 shrink items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={t(MODE_META[mode].descKey)}
      >
        <CurrentIcon className="h-3 w-3 shrink-0" />
        <span className="hidden min-w-0 truncate @min-[28rem]:inline">
          {t(MODE_META[mode].labelKey)}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-80 [&_[data-slot=popover-viewport]]:p-1">
        {MODES.map((option) => {
          const meta = MODE_META[option];
          const Icon = meta.icon;
          const selected = option === mode;
          const disabled = option === 'assistant' && !reviewerReady;
          return (
            <button
              key={option}
              type="button"
              disabled={disabled}
              onClick={() => {
                if (disabled) return;
                onSelect(option);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                selected ? 'bg-muted' : 'hover:bg-muted/60',
                disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
              )}
            >
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block">{t(meta.labelKey)}</span>
                <span className="block text-xs text-muted-foreground">
                  {disabled
                    ? t('Select an assistant approval model in Settings first')
                    : t(meta.descKey)}
                </span>
              </span>
              {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            </button>
          );
        })}
      </PopoverPopup>
    </Popover>
  );
}
