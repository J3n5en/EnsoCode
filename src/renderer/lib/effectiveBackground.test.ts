import { describe, expect, it } from 'vitest';
import { effectiveBackground, type UserBackground } from './effectiveBackground';

const user: UserBackground = {
  backgroundImageEnabled: false,
  backgroundSizeMode: 'repeat',
  backgroundOpacity: 0.4,
  backgroundBlur: 6,
  backgroundBrightness: 0.9,
  backgroundSaturation: 1.1,
  backgroundMask: 0.2,
  backgroundComposerOpacity: 0.3,
  backgroundCodeOpacity: 0.35,
};

const image = { src: 'u/bg' };

describe('effectiveBackground', () => {
  it('都没有背景时为 null', () => {
    expect(effectiveBackground(user, undefined)).toBeNull();
  });

  it('用户开了背景图时用用户的参数，主题背景不生效', () => {
    expect(
      effectiveBackground({ ...user, backgroundImageEnabled: true }, { image, blur: 12, mask: 1 })
    ).toEqual({
      source: 'user',
      size: 'repeat',
      opacity: 0.4,
      blur: 6,
      brightness: 0.9,
      saturation: 1.1,
      mask: 0.2,
      composerOpacity: 0.3,
      codeOpacity: 0.35,
    });
  });

  it('用户没开时按主题参数生效，缺的参数取设置页默认值', () => {
    expect(effectiveBackground(user, { image, size: 'contain', blur: 12 })).toEqual({
      source: 'theme',
      size: 'contain',
      opacity: 0.85,
      blur: 12,
      brightness: 1,
      saturation: 1,
      mask: 0.5,
      composerOpacity: 0.6,
      codeOpacity: 0.65,
    });
  });
});
