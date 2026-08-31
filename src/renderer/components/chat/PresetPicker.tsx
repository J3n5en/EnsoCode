import { DEFAULT_PRESET_ID } from '@shared/types';
import { Check, ChevronDown, Layers } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';

interface PresetPickerProps {
  presetId: string;
  onSelect: (presetId: string) => void;
  /** 会话已开始后预设固化，不能中途替换（skill/MCP/指令在 spawn 时注入） */
  disabled?: boolean;
}

/** composer 工具行的预设选择：pill 触发 + 默认/自定义预设列表（会话开始前可选，之后只读） */
export function PresetPicker({ presetId, onSelect, disabled }: PresetPickerProps) {
  const { t } = useI18n();
  const presets = useSettingsStore((state) => state.presets);
  const [open, setOpen] = useState(false);

  const options = [
    { id: DEFAULT_PRESET_ID, name: t('Global') },
    ...presets.map((preset) => ({ id: preset.id, name: preset.name })),
  ];
  // 被删除的预设回落默认显示
  const current = options.find((option) => option.id === presetId) ?? options[0];

  if (disabled) {
    return (
      <span
        className="flex h-7 max-w-40 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground"
        title={t('Preset is locked after the conversation starts')}
      >
        <Layers className="h-3 w-3 shrink-0" />
        <span className="truncate">{current.name}</span>
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex h-7 max-w-40 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
        <Layers className="h-3 w-3 shrink-0" />
        <span className="truncate">{current.name}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-52 [&_[data-slot=popover-viewport]]:p-1">
        {options.map((option) => {
          const selected = option.id === current.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                onSelect(option.id);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                selected
                  ? 'bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </button>
          );
        })}
      </PopoverPopup>
    </Popover>
  );
}
