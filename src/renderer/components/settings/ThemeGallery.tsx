import type { ThemeDefinition, ThemeKey, ThemePalette } from '@shared/theme/types';
import { Puzzle } from 'lucide-react';
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
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,13.5rem),1fr))] gap-3">
      {themes.map((theme) => {
        const on = theme.id === selected;
        return (
          <button
            type="button"
            key={theme.id}
            data-theme-card={theme.id}
            data-settings-preview=""
            aria-pressed={on}
            onClick={() => onSelect(theme.id)}
            className={cn(
              'group relative flex w-full min-w-0 flex-col overflow-hidden text-left',
              'rounded-md',
              on
                ? 'border border-transparent shadow-[0_0_0_2px_var(--brand)]'
                : 'border border-border hover:border-input'
            )}
          >
            <ThemePreview palette={theme[mode]} />
            <div className="flex min-w-0 items-center gap-1.5 bg-background px-2.5 py-2 text-[13px]">
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
            'flex min-h-[124px] min-w-0 flex-col items-center justify-center gap-1.5 text-sm text-subtle-foreground hover:text-foreground',
            'rounded-md',
            'border border-dashed border-border hover:border-input'
          )}
        >
          <Puzzle className="size-[18px]" />
          {t('Get more themes')}
        </button>
      )}
    </div>
  );
}
