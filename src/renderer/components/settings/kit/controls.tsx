import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from '@/components/ui/number-field';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useSettingsRow, useSettingsRowControl } from './layout';

export interface SettingsOption<T extends string> {
  value: T;
  label: string;
}

const WIDTH = { default: 'w-[220px]', wide: 'w-[280px]' } as const;

export function SettingsSwitch({
  checked,
  onCheckedChange,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Switch
      {...useSettingsRowControl()}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className="relative"
    />
  );
}

/** 与对话框、工作区同一套：ui Button 的 sm 尺寸，默认描边款 */
export function SettingsButton(props: React.ComponentProps<typeof Button>) {
  return <Button size="sm" variant="outline" {...props} />;
}

export function SettingsSelect<T extends string>({
  value,
  onValueChange,
  options,
  width = 'default',
  disabled,
  'aria-label': ariaLabel,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SettingsOption<T>[];
  width?: keyof typeof WIDTH;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const a11y = useSettingsRowControl();
  return (
    <Select
      items={Object.fromEntries(options.map((option) => [option.value, option.label]))}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const hit = options.find((option) => option.value === next);
        if (hit) onValueChange(hit.value);
      }}
    >
      <SelectTrigger
        size="sm"
        {...a11y}
        aria-label={ariaLabel}
        className={cn(WIDTH[width], 'max-w-full')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** 两到四个互斥选项；方向键在选项间移动 */
export function SettingsSegmented<T extends string>({
  value,
  onValueChange,
  options,
  'aria-label': ariaLabel,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SettingsOption<T>[];
  'aria-label'?: string;
}) {
  const a11y = useSettingsRowControl();
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onValueChange(options[next].value);
    const siblings = event.currentTarget.parentElement?.querySelectorAll('button');
    (siblings?.[next] as HTMLButtonElement | undefined)?.focus();
  };
  return (
    <div
      role="radiogroup"
      {...a11y}
      aria-label={ariaLabel}
      className="flex h-(--settings-control-h) max-w-full items-center rounded-md bg-muted p-0.5"
    >
      {/* 触屏热区高 44px：滚动框会把它上下裁掉，用 padding 放出、负 margin 抵消，布局不变 */}
      <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto pointer-coarse:-my-[12px] pointer-coarse:py-[12px]">
        {options.map((option, index) => {
          const on = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onValueChange(option.value)}
              onKeyDown={(event) => move(event, index)}
              className={cn(
                'h-6 shrink-0 whitespace-nowrap rounded-[4px] px-2.5 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-w-[44px]',
                on
                  ? 'bg-background text-foreground shadow-xs ring-1 ring-border'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 即时生效：停止输入 600ms 或失焦时保存，并在行内提示「已保存」 */
export function SettingsInput({
  value,
  onCommit,
  placeholder,
  type = 'text',
  width = 'default',
  debounceMs = 600,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'url' | 'password';
  width?: keyof typeof WIDTH;
  debounceMs?: number;
}) {
  const a11y = useSettingsRowControl();
  const row = useSettingsRow();
  const [draft, setDraft] = React.useState(value);
  const committed = React.useRef(value);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => {
    committed.current = value;
    setDraft(value);
  }, [value]);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const commit = (next: string) => {
    clearTimeout(timer.current);
    if (next === committed.current) return;
    committed.current = next;
    onCommit(next);
    row?.markSaved();
  };
  return (
    <Input
      {...a11y}
      size="sm"
      type={type}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setDraft(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(next), debounceMs);
      }}
      onBlur={() => commit(draft)}
      className={cn(
        WIDTH[width],
        'max-w-full max-sm:[&>input]:h-[42px] max-sm:[&>input]:leading-[42px]'
      )}
    />
  );
}

export function SettingsStepper({
  value,
  onValueChange,
  min,
  max,
  step = 1,
}: {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const { id, ...a11y } = useSettingsRowControl();
  const row = useSettingsRow();
  return (
    <NumberField
      id={id}
      size="sm"
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={(next) => {
        if (next === null || next === value) return;
        onValueChange(next);
        row?.markSaved();
      }}
      className="w-[120px] max-w-full"
    >
      <NumberFieldGroup>
        <NumberFieldDecrement />
        <NumberFieldInput {...a11y} />
        <NumberFieldIncrement />
      </NumberFieldGroup>
    </NumberField>
  );
}
