import type { ApprovalMode } from '@shared/types/agent';
import { Check, ChevronDown, Moon, Shield, ShieldCheck, ShieldOff, Sparkles } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useMaterializedProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';

export const APPROVAL_MODE_META: Record<
  ApprovalMode,
  { icon: typeof Shield; labelKey: string; descKey: string }
> = {
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

export const APPROVAL_MODE_ORDER: ApprovalMode[] = [
  'supervised',
  'auto-edits',
  'full',
  'assistant',
];

interface ApprovalModePickerProps {
  mode: ApprovalMode;
  onSelect: (mode: ApprovalMode) => void;
  /** 无人值守：需要确认的动作直接拒绝，不等真人（与档位正交） */
  autoReject: boolean;
  onToggleAutoReject: (value: boolean) => void;
}

/** 助手代审档位可用：设置里选了启用中的代审模型 */
export function useApprovalReviewerReady(): boolean {
  const reviewer = useSettingsStore((state) => state.approvalReviewer);
  const providers = useMaterializedProviders();
  return useMemo(() => {
    if (!reviewer) return false;
    const provider = providers.find(
      (entry) => entry.id === reviewer.providerId && entry.enabled !== false
    );
    return Boolean(
      provider?.models.some((entry) => entry.id === reviewer.modelId && entry.enabled !== false)
    );
  }, [providers, reviewer]);
}

/** composer 工具行的审批档位选择（盾牌 pill），会话中途可切换即时生效 */
export function ApprovalModePicker({
  mode,
  onSelect,
  autoReject,
  onToggleAutoReject,
}: ApprovalModePickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const reviewerReady = useApprovalReviewerReady();
  const CurrentIcon = APPROVAL_MODE_META[mode].icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="flex h-7 min-w-0 shrink items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={t(APPROVAL_MODE_META[mode].descKey)}
      >
        <CurrentIcon className="h-3 w-3 shrink-0" />
        <span className="hidden min-w-0 truncate @min-[28rem]:inline">
          {t(APPROVAL_MODE_META[mode].labelKey)}
        </span>
        {autoReject && <Moon className="h-3 w-3 shrink-0" aria-label={t('Unattended')} />}
        <ChevronDown className="h-3 w-3 shrink-0" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-80 [&_[data-slot=popover-viewport]]:p-1">
        {APPROVAL_MODE_ORDER.map((option) => {
          const meta = APPROVAL_MODE_META[option];
          const Icon = meta.icon;
          const selected = option === mode;
          const disabled = option === 'assistant' && !reviewerReady;
          return (
            <Fragment key={option}>
              <button
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
            </Fragment>
          );
        })}
        <div className="my-1 h-px bg-border" />
        <button
          type="button"
          role="switch"
          aria-checked={autoReject}
          onClick={() => onToggleAutoReject(!autoReject)}
          className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
        >
          <Moon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block">{t('Unattended')}</span>
            <span className="block text-xs text-muted-foreground">
              {t('Rejects actions that need approval instead of waiting for you')}
            </span>
          </span>
          <span
            className={cn(
              'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
              autoReject ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
            )}
          >
            {autoReject && <Check className="h-3 w-3" />}
          </span>
        </button>
      </PopoverPopup>
    </Popover>
  );
}
