import { THEME_BACKGROUND_PARAMS } from '@shared/theme/assets';
import type {
  ThemeBackground,
  ThemeBackgroundParam,
  ThemeBackgroundSize,
} from '@shared/theme/types';
import type { SettingsState } from '@/stores/settings';

export type UserBackground = Pick<
  SettingsState,
  | 'backgroundImageEnabled'
  | 'backgroundSizeMode'
  | 'backgroundOpacity'
  | 'backgroundBlur'
  | 'backgroundBrightness'
  | 'backgroundSaturation'
  | 'backgroundMask'
  | 'backgroundComposerOpacity'
  | 'backgroundCodeOpacity'
>;

export type EffectiveBackground = { source: 'user' | 'theme'; size: ThemeBackgroundSize } & Record<
  ThemeBackgroundParam,
  number
>;

/** 用户开了背景图就用用户的；否则用当前主题自带的，缺的参数取设置页默认值 */
export function effectiveBackground(
  user: UserBackground,
  theme: ThemeBackground | undefined
): EffectiveBackground | null {
  if (user.backgroundImageEnabled)
    return {
      source: 'user',
      size: user.backgroundSizeMode,
      opacity: user.backgroundOpacity,
      blur: user.backgroundBlur,
      brightness: user.backgroundBrightness,
      saturation: user.backgroundSaturation,
      mask: user.backgroundMask,
      composerOpacity: user.backgroundComposerOpacity,
      codeOpacity: user.backgroundCodeOpacity,
    };
  if (!theme) return null;
  const params = Object.fromEntries(
    Object.entries(THEME_BACKGROUND_PARAMS).map(([key, range]) => [
      key,
      theme[key as ThemeBackgroundParam] ?? range.default,
    ])
  ) as Record<ThemeBackgroundParam, number>;
  return { source: 'theme', size: theme.size ?? 'cover', ...params };
}
