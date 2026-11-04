import type { ThemeDefinition, ThemeKey, ThemePalette } from '@shared/theme/types';
import { Puzzle } from 'lucide-react';
import type * as React from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

const SIDEBAR_BARS = ['100%', '100%', '70%', '100%', '55%'];
const BODY_BARS = ['100%', '85%', '60%'];

/** 用调色板画迷你窗口：画布上的侧栏、表面卡片、正文条与带强调色点的输入框 */
function ThemePreview({ palette }: { palette: ThemePalette }) {
  return (
    <div className="flex h-[88px] gap-1.5 p-[7px]" style={{ background: palette.canvas }}>
      <div className="flex w-[30%] flex-col gap-[5px] px-0.5 py-1">
        <i
          className="block h-[9px] rounded-[3px] opacity-[.18]"
          style={{ background: palette.text }}
        />
        {SIDEBAR_BARS.slice(1).map((width, index) => (
          <i
            // biome-ignore lint/suspicious/noArrayIndexKey: 装饰条，顺序固定
            key={index}
            className="block h-[5px] rounded-[3px] opacity-55"
            style={{ background: palette.textSubtle, width }}
          />
        ))}
      </div>
      <div
        className="flex flex-1 flex-col gap-[5px] rounded-md px-2.5 py-2"
        style={{ background: palette.surface, boxShadow: `0 0 0 1px ${palette.border}` }}
      >
        <i
          className="block h-1 w-[70%] rounded-sm opacity-75"
          style={{ background: palette.text }}
        />
        {BODY_BARS.map((width) => (
          <i
            key={width}
            className="block h-1 rounded-sm opacity-50"
            style={{ background: palette.textSubtle, width }}
          />
        ))}
        <b
          className="mt-auto flex h-3.5 justify-end rounded-full p-[3px]"
          style={{ background: palette.sunken, boxShadow: `0 0 0 1px ${palette.border}` }}
        >
          <span
            data-theme-accent
            className="size-2 rounded-full"
            style={{ background: palette.accent }}
          />
        </b>
      </div>
    </div>
  );
}

const CARD = 'overflow-hidden rounded-lg border text-left transition-shadow';

export function ThemeGallery({
  themes,
  selected,
  mode,
  onSelect,
  onGetMore,
}: {
  themes: readonly ThemeDefinition[];
  selected: ThemeKey;
  mode: 'light' | 'dark';
  onSelect: (id: ThemeKey) => void;
  onGetMore?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-3 gap-3">
      {themes.map((theme) => {
        const on = theme.id === selected;
        return (
          <button
            type="button"
            key={theme.id}
            data-theme-card={theme.id}
            aria-pressed={on}
            onClick={() => onSelect(theme.id)}
            className={cn(
              CARD,
              'bg-card',
              on ? 'border-transparent shadow-[0_0_0_2px_var(--brand)]' : 'hover:border-input'
            )}
          >
            <ThemePreview palette={theme[mode]} />
            <div className="flex items-center gap-1.5 border-t px-2.5 py-[7px] text-sm">
              <span className="truncate font-medium">{theme.name}</span>
              <span
                className={cn(
                  'ml-auto shrink-0 truncate rounded-full px-1.5 py-px text-[10.5px]',
                  theme.source.kind === 'plugin'
                    ? 'max-w-[60%] bg-brand/12 text-brand'
                    : 'bg-muted text-subtle-foreground'
                )}
              >
                {theme.source.kind === 'plugin'
                  ? t('Plugin · {{name}}', { name: theme.source.pluginName })
                  : t('Built-in')}
              </span>
            </div>
          </button>
        );
      })}
      {onGetMore && (
        <button
          type="button"
          onClick={onGetMore}
          className={cn(
            CARD,
            'flex min-h-[124px] flex-col items-center justify-center gap-1.5 border-dashed text-sm text-subtle-foreground hover:border-input hover:text-foreground'
          )}
        >
          <Puzzle className="size-[18px]" />
          {t('Get more themes')}
        </button>
      )}
    </div>
  );
}

/** 外观页的设置行：左侧标题与说明，右侧控件 */
export function AppearanceRow({
  rowId,
  title,
  description,
  children,
}: {
  rowId?: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-settings-row={rowId}
      className="flex min-h-12 items-center justify-between gap-4 px-3.5 py-2.5"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function AppearanceCard({ children }: { children: React.ReactNode }) {
  return <div className="divide-y rounded-lg border bg-card">{children}</div>;
}
