import { AnimatePresence, MotionGlobalConfig, motion, useReducedMotion } from 'framer-motion';
import { Check, ChevronRight } from 'lucide-react';
import * as React from 'react';
import { useI18n } from '@/i18n';
import { heightVariants } from '@/lib/motion';
import { cn } from '@/lib/utils';

interface RowContextValue {
  controlId: string;
  labelId: string;
  descriptionId?: string;
  markSaved: () => void;
}

const RowContext = React.createContext<RowContextValue | null>(null);

export const useSettingsRow = () => React.useContext(RowContext);

/** 行内控件用它拿到与标签、说明关联的 id；不在行内时为空 */
export function useSettingsRowControl(): {
  id?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
} {
  const row = React.useContext(RowContext);
  if (!row) return {};
  return {
    id: row.controlId,
    'aria-labelledby': row.labelId,
    'aria-describedby': row.descriptionId,
  };
}

function useSavedFlash(): [boolean, () => void] {
  const [saved, setSaved] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const mark = React.useCallback(() => {
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), 1500);
  }, []);
  return [saved, mark];
}

export function SettingsSaved({ className }: { className?: string } = {}) {
  const { t } = useI18n();
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        'settings-saved-pop inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-1.5 py-0.5 font-normal text-[11px] leading-none text-success',
        className
      )}
    >
      <Check className="size-3 shrink-0" />
      {t('Saved')}
    </span>
  );
}

/** 内容本身是个对象（图表、预览）：只这一层边框，里面不能再画框 */
export function SettingsPreview({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="settings-preview"
      data-settings-preview=""
      className={cn(
        'overflow-hidden rounded-[12px] border border-border/80 bg-muted/35 dark:bg-card',
        className
      )}
      {...props}
    />
  );
}

export function SettingsEmptyState({
  icon: Icon,
  title,
  description,
  actions,
  compact = false,
}: {
  icon?: React.ElementType;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      data-slot="settings-empty"
      className={cn(
        'flex flex-col items-center justify-center px-4 text-center',
        compact ? 'py-6' : 'py-9'
      )}
    >
      {Icon && (
        <div className="mb-3 flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </div>
      )}
      <p className="font-medium text-[13px] text-foreground">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-[12px] text-muted-foreground leading-[18px]">
          {description}
        </p>
      )}
      {actions && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{actions}</div>
      )}
    </div>
  );
}

export function SettingsPage({
  title,
  description,
  badge,
  actions,
  rowId,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  rowId?: string;
  children?: React.ReactNode;
}) {
  return (
    <div data-slot="settings-page" className="mx-auto w-full max-w-(--settings-content-max) pb-12">
      {/* 标题区按 280px 参与换行：操作按钮放不下时整组换到标题下面，标题不被挤成竖排 */}
      <header data-settings-row={rowId} className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-[min(100%,280px)] grow basis-[280px]">
          <h1 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-semibold text-[19px] leading-[26px] tracking-[-0.015em]">
            {title}
            {badge}
          </h1>
          {description && (
            <p className="mt-1 text-[13px] text-muted-foreground leading-5">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2 pointer-coarse:gap-y-4">
            {actions}
          </div>
        )}
      </header>
      {children}
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  actions,
  tone,
  bare = false,
  rowId,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  tone?: 'danger';
  bare?: boolean;
  rowId?: string;
  children?: React.ReactNode;
}) {
  const hasHead = title || description || actions;
  return (
    <section data-settings-row={rowId} className="mt-(--settings-section-gap)">
      {hasHead && (
        <div className="mb-2 flex flex-wrap items-end gap-x-4 gap-y-2 px-1">
          <div className="min-w-0 flex-1">
            {title && (
              <h2
                className={cn(
                  'font-semibold text-[13px] leading-5 tracking-[-0.005em] text-foreground/85',
                  tone === 'danger' && 'text-destructive-text'
                )}
              >
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-0.5 text-[12px] text-muted-foreground leading-[18px]">
                {description}
              </p>
            )}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {bare ? (
        <div>{children}</div>
      ) : (
        <div
          data-slot="settings-group"
          data-tone={tone}
          className={cn(
            'empty:hidden overflow-hidden rounded-[12px] border border-border/80 bg-muted/35 dark:bg-card',
            'shadow-[0_1px_2px_0_oklch(0_0_0/0.025)] dark:shadow-none',
            tone === 'danger' &&
              'border-destructive/30 bg-destructive/[0.03] dark:bg-destructive/[0.06]'
          )}
        >
          {children}
        </div>
      )}
    </section>
  );
}

export interface SettingsRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  rowId?: string;
  /** 控件左侧的行内状态（冲突、连接失败等） */
  status?: React.ReactNode;
  /** 标签左侧的小元素（展开箭头、图标） */
  leading?: React.ReactNode;
  indent?: boolean;
  interactive?: boolean;
  /** stack：标签一行在上，控件独占下方整行（多行文本框用，免得被收缩宽度压成窄条） */
  layout?: 'row' | 'stack';
  children?: React.ReactNode;
}

export function SettingsRow({
  label,
  description,
  rowId,
  status,
  leading,
  indent = false,
  interactive = false,
  layout = 'row',
  children,
}: SettingsRowProps) {
  const base = React.useId();
  const [saved, markSaved] = useSavedFlash();
  const context = React.useMemo<RowContextValue>(
    () => ({
      controlId: `${base}control`,
      labelId: `${base}label`,
      descriptionId: description ? `${base}description` : undefined,
      markSaved,
    }),
    [base, description, markSaved]
  );
  const trailing = status || children;
  const head = (
    <div className="flex min-w-[min(100%,12rem)] flex-1 items-center gap-2">
      {leading}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <label
            id={context.labelId}
            htmlFor={context.controlId}
            className={cn('block text-[13px] leading-5', !indent && 'font-medium')}
          >
            {label}
          </label>
          {saved && <SettingsSaved />}
        </div>
        {description && (
          // div：说明里可能放额度条这类块级内容
          <div
            id={context.descriptionId}
            className="mt-0.5 text-[12px] text-muted-foreground leading-[18px]"
          >
            {description}
          </div>
        )}
      </div>
    </div>
  );
  const stack = layout === 'stack';
  return (
    <RowContext.Provider value={context}>
      <div
        data-slot="settings-row"
        data-settings-row={rowId}
        className={cn(
          'flex gap-x-6 gap-y-2 transition-colors duration-150',
          stack ? 'flex-col' : 'flex-wrap items-center',
          indent
            ? 'min-h-[44px] py-2.5 pl-10 pr-4 max-sm:pl-7 max-sm:pr-3'
            : 'min-h-(--settings-row-min) px-4 py-3 max-sm:px-3',
          interactive && 'hover:bg-accent/35'
        )}
      >
        {stack ? (
          <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              {head}
              {status && (
                <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
                  {status}
                </div>
              )}
            </div>
            {children && <div className="w-full min-w-0">{children}</div>}
          </>
        ) : (
          head
        )}
        {!stack && trailing && (
          // 收缩宽度的控件区里放 field-sizing-content 的多行文本框会被压成窄条：有文本框就换到整行
          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2 has-[[data-slot=textarea-control]]:ml-0 has-[[data-slot=textarea-control]]:w-full">
            {status}
            {children}
          </div>
        )}
      </div>
    </RowContext.Provider>
  );
}

export function SettingsSubRow(props: Omit<SettingsRowProps, 'indent'>) {
  return <SettingsRow {...props} indent />;
}

/** 服务商 / 插件 / MCP 这类列表：展开后是缩进子行，不是内嵌卡片 */
export function SettingsExpandableRow({
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  control,
  children,
  label,
  ...row
}: Omit<SettingsRowProps, 'leading' | 'indent' | 'interactive' | 'children'> & {
  defaultOpen?: boolean;
  /** 受控展开：外部需要主动展开（例如校验失败要露出错误）时传 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  control?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const [ownOpen, setOwnOpen] = React.useState(defaultOpen);
  const open = openProp ?? ownOpen;
  const regionId = React.useId();
  const reducedMotion = useReducedMotion();
  const reduced = reducedMotion === true || MotionGlobalConfig.skipAnimations === true;
  // 列表行点名字是展开；拦掉 label 的默认激活，免得顺手切了右侧的启用开关
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const toggle = (event: React.MouseEvent) => {
    event.preventDefault();
    setOpen(!open);
  };
  return (
    <div data-slot="settings-expandable">
      <SettingsRow
        {...row}
        interactive
        label={
          // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘走左侧的展开按钮
          <span className="cursor-pointer" onClick={toggle}>
            {label}
          </span>
        }
        leading={
          <button
            type="button"
            aria-expanded={open}
            aria-controls={regionId}
            aria-label={open ? t('Collapse') : t('Expand')}
            onClick={() => setOpen(!open)}
            className="relative -ml-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
          >
            <ChevronRight
              className={cn(
                'size-4 transition-transform duration-200 ease-[var(--ease-smooth-out)]',
                open && 'rotate-90'
              )}
            />
          </button>
        }
      >
        {control}
      </SettingsRow>
      {reduced ? (
        open ? (
          <div
            id={regionId}
            data-slot="settings-sub-group"
            className="overflow-hidden border-t border-border/60 bg-muted/45 dark:bg-background/40"
          >
            {children}
          </div>
        ) : null
      ) : (
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              id={regionId}
              data-slot="settings-sub-group"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={heightVariants}
              className="overflow-hidden border-t border-border/60 bg-muted/45 dark:bg-background/40"
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}
