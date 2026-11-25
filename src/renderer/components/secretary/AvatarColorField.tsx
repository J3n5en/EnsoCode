import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { AVATAR_PRESET_COLORS, avatarColorSelection, normalizeAvatarColor } from './avatarColor';

/** 六个预设色加自定义入口。自定义和预设改的是同一个 color 字段。 */
export function AvatarColorField({
  color,
  onChange,
}: {
  color: string;
  onChange: (color: string) => void;
}) {
  const { t } = useI18n();
  const [hex, setHex] = useState(color);
  useEffect(() => setHex(color), [color]);
  const selection = avatarColorSelection(color);
  const commit = (value: string) => {
    const next = normalizeAvatarColor(value);
    if (next) onChange(next);
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 pointer-coarse:gap-[23px]"
      data-enso="secretary-form-avatar"
    >
      {AVATAR_PRESET_COLORS.map((preset) => (
        <button
          key={preset}
          type="button"
          aria-pressed={selection.preset === preset}
          aria-label={preset}
          onClick={() => onChange(preset)}
          style={{ backgroundColor: preset }}
          className={cn(
            'size-6 rounded-full border-2 transition-transform',
            selection.preset === preset ? 'border-foreground' : 'border-transparent hover:scale-105'
          )}
        />
      ))}
      <label
        data-enso="secretary-form-avatar-custom"
        data-selected={selection.customSelected ? 'true' : 'false'}
        title={t('Custom color')}
        style={selection.customSelected ? { backgroundColor: color } : undefined}
        className={cn(
          'relative grid size-6 cursor-pointer place-items-center overflow-hidden rounded-full border-2 text-[10px] pointer-coarse:overflow-visible',
          selection.customSelected
            ? 'border-foreground text-white'
            : 'border-border text-muted-foreground'
        )}
      >
        <span aria-hidden className={selection.customSelected ? 'sr-only' : undefined}>
          +
        </span>
        <input
          type="color"
          aria-label={t('Custom color')}
          value={normalizeAvatarColor(color) ?? '#7c5cff'}
          onChange={(event) => commit(event.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0 pointer-coarse:-inset-[12px]"
        />
      </label>
      <Input
        data-enso="secretary-form-avatar-hex"
        value={hex}
        spellCheck={false}
        aria-label={t('Custom color')}
        onChange={(event) => {
          const value = event.target.value;
          setHex(value);
          commit(value);
        }}
        className="h-7 w-24 font-mono text-xs"
      />
    </div>
  );
}
