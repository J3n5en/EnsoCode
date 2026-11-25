import { Search, X } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
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
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsRow, useSettingsRowControl } from './layout';

export interface SettingsOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ElementType;
  /** 行为测试与验收钩子 */
  dataEnso?: string;
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
  const trackRef = React.useRef<HTMLDivElement>(null);
  const buttonRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [indicator, setIndicator] = React.useState<{ left: number; width: number } | null>(null);
  const [animate, setAnimate] = React.useState(false);
  const hasMeasuredRef = React.useRef(false);
  const prevValueRef = React.useRef(value);

  const measure = React.useCallback(
    (shouldAnimate: boolean) => {
      const activeIndex = options.findIndex((option) => option.value === value);
      const btn = activeIndex >= 0 ? buttonRefs.current[activeIndex] : null;
      if (!btn || btn.offsetWidth === 0) {
        setIndicator(null);
        return;
      }
      const left = btn.offsetLeft;
      const width = btn.offsetWidth;
      setAnimate(shouldAnimate && hasMeasuredRef.current);
      setIndicator({ left, width });
      hasMeasuredRef.current = true;
    },
    [options, value]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: options.length tracks dynamic option lists
  React.useLayoutEffect(() => {
    const changed = prevValueRef.current !== value;
    prevValueRef.current = value;
    measure(changed);
  }, [value, options.length, measure]);

  React.useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure(false));
    ro.observe(track);
    return () => ro.disconnect();
  }, [measure]);

  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onValueChange(options[next].value);
    buttonRefs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      {...a11y}
      aria-label={ariaLabel}
      className="inline-flex h-(--settings-control-h) max-w-full items-center rounded-[8px] bg-muted/85 p-0.5 dark:bg-muted/70"
    >
      {/* 触屏热区高 44px：滚动框会把它上下裁掉，用 padding 放出、负 margin 抵消，布局不变 */}
      <div
        ref={trackRef}
        className="relative flex min-w-0 items-center gap-0.5 overflow-x-auto pointer-coarse:-my-[12px] pointer-coarse:py-[12px]"
      >
        {indicator && (
          <span
            aria-hidden="true"
            data-slot="segmented-indicator"
            style={{
              width: `${indicator.width}px`,
              transform: `translateX(${indicator.left}px)`,
            }}
            className={cn(
              'pointer-events-none absolute top-0 bottom-0 left-0 z-0 rounded-[6px]',
              'bg-background shadow-[0_1px_2px_oklch(0_0_0/0.08),0_0_0_0.5px_var(--color-border)]',
              'dark:bg-popover dark:shadow-[0_1px_3px_oklch(0_0_0/0.35),0_0_0_0.5px_var(--color-border)]',
              'pointer-coarse:top-[12px] pointer-coarse:bottom-[12px]',
              animate &&
                'transition-[transform,width] duration-200 ease-[var(--ease-smooth-out)] motion-reduce:transition-none'
            )}
          />
        )}
        {options.map((option, index) => {
          const on = option.value === value;
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              ref={(el) => {
                buttonRefs.current[index] = el;
              }}
              type="button"
              role="radio"
              data-enso={option.dataEnso}
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onValueChange(option.value)}
              onKeyDown={(event) => move(event, index)}
              className={cn(
                'relative z-10 inline-flex h-6 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 text-[12px] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-w-[44px]',
                on
                  ? cn(
                      'font-medium text-foreground',
                      !indicator && 'bg-background shadow-xs ring-1 ring-border'
                    )
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {Icon && <Icon className="size-3.5 shrink-0" />}
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

/** 设置导航的搜索框：边输边筛；有字时 Esc 只清空，不往外冒到「Esc 退出设置」 */
export function SettingsSearch({
  value,
  onValueChange,
  placeholder,
  inputRef,
  onArrowDown,
}: {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** 有命中时，向下把焦点交给第一条结果 */
  onArrowDown?: () => void;
}) {
  const { t } = useI18n();
  const localRef = React.useRef<HTMLInputElement>(null);
  const setRefs = React.useCallback(
    (node: HTMLInputElement | null) => {
      localRef.current = node;
      if (inputRef) inputRef.current = node;
    },
    [inputRef]
  );
  return (
    <InputGroup data-size="sm" className="max-md:[&_input]:h-10 max-md:[&_input]:text-base">
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        ref={setRefs}
        size="sm"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && onArrowDown) {
            event.preventDefault();
            onArrowDown();
            return;
          }
          if (event.key !== 'Escape' || value.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          onValueChange('');
        }}
      />
      {value.length > 0 && (
        <InputGroupAddon align="inline-end">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('Clear search')}
            onClick={() => {
              onValueChange('');
              localRef.current?.focus();
            }}
          >
            <X className="size-3.5" />
          </Button>
        </InputGroupAddon>
      )}
    </InputGroup>
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
