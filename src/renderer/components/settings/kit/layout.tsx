import { Check, ChevronRight } from 'lucide-react';
import * as React from 'react';
import { useI18n } from '@/i18n';
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

export function SettingsSaved() {
  const { t } = useI18n();
  return (
    <span role="status" className="flex items-center gap-1 text-[12px] text-muted-foreground">
      <Check className="size-3.5 text-success" />
      {t('Saved')}
    </span>
  );
}

/** 内容本身是个对象（图表、预览）：只这一层边框，里面不能再画框 */
export function SettingsPreview({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-settings-preview="" className={cn('rounded-lg border', className)} {...props} />;
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
    <div data-slot="settings-page" className="mx-auto w-full max-w-(--settings-content-max) pb-10">
      {/* 标题区按 280px 参与换行：操作按钮放不下时整组换到标题下面，标题不被挤成竖排 */}
      <header data-settings-row={rowId} className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-[min(100%,280px)] grow basis-[280px]">
          <h1 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-semibold text-[18px] leading-[26px]">
            {title}
            {badge}
          </h1>
          {description && (
            <p className="mt-0.5 text-[13px] text-muted-foreground leading-5">{description}</p>
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
  rowId,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  tone?: 'danger';
  rowId?: string;
  children?: React.ReactNode;
}) {
  const hasHead = title || description || actions;
  return (
    <section data-settings-row={rowId} className="mt-(--settings-section-gap)">
      {hasHead && (
        <div className="mb-2 flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            {title && (
              <h2
                className={cn(
                  'font-semibold text-[14px] leading-5',
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
      <div className="border-border border-t">{children}</div>
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
  children?: React.ReactNode;
}

export function SettingsRow({
  label,
  description,
  rowId,
  status,
  leading,
  indent = false,
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
  const trailing = saved || status || children;
  return (
    <RowContext.Provider value={context}>
      <div
        data-slot="settings-row"
        data-settings-row={rowId}
        className={cn(
          'flex flex-wrap items-center gap-x-6 gap-y-2 border-border border-b',
          indent ? 'min-h-[44px] py-2 pl-10' : 'min-h-(--settings-row-min) py-3'
        )}
      >
        <div className="flex min-w-[min(100%,12rem)] flex-1 items-center gap-2">
          {leading}
          <div className="min-w-0 flex-1">
            <label
              id={context.labelId}
              htmlFor={context.controlId}
              className={cn('block text-[13px] leading-5', !indent && 'font-medium')}
            >
              {label}
            </label>
            {description && (
              // div：说明里可能放额度条这类块级内容
              <div
                id={context.descriptionId}
                className="mt-px text-[12px] text-muted-foreground leading-[18px]"
              >
                {description}
              </div>
            )}
          </div>
        </div>
        {trailing && (
          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
            {saved && <SettingsSaved />}
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
}: Omit<SettingsRowProps, 'leading' | 'indent' | 'children'> & {
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
    <>
      <SettingsRow
        {...row}
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
            className="relative -ml-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
          </button>
        }
      >
        {control}
      </SettingsRow>
      {open && <div id={regionId}>{children}</div>}
    </>
  );
}
