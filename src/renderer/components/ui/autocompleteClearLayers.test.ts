import { describe, expect, it } from 'vitest';
import { nextClearLayerState } from './autocompleteClearLayers';

describe('nextClearLayerState', () => {
  it('有值时镜像层代显示文字，空格换成不换行空格', () => {
    expect(nextClearLayerState({ value: '/Users/a b', mirrorText: '', clearing: false })).toEqual({
      hasValue: true,
      mirrorText: '/Users/a\u00a0b',
      superseded: false,
    });
  });

  it('空值不显示镜像层', () => {
    expect(nextClearLayerState({ value: '', mirrorText: '/old', clearing: false })).toEqual({
      hasValue: false,
      mirrorText: '',
      superseded: false,
    });
  });

  it('程序化改了值而动画还没结束：放弃动画并按新值显示', () => {
    expect(
      nextClearLayerState({
        value: '/Users/new-path',
        mirrorText: '/Users/old-path',
        clearing: true,
      })
    ).toEqual({ hasValue: true, mirrorText: '/Users/new-path', superseded: true });
  });

  it('清除动画自身把值置空时不算被顶替', () => {
    expect(
      nextClearLayerState({ value: '', mirrorText: '/Users/old-path', clearing: true })
    ).toEqual({ hasValue: false, mirrorText: '', superseded: false });
  });

  it('值没变且不在动画中不做任何顶替', () => {
    expect(
      nextClearLayerState({ value: '/Users/same', mirrorText: '/Users/same', clearing: false })
    ).toEqual({ hasValue: true, mirrorText: '/Users/same', superseded: false });
  });
});
