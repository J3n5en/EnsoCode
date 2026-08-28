import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATUS_LINE_SEGMENTS,
  normalizeStatusLineSegments,
  reorderStatusLineSegments,
  STATUS_LINE_PRESET_IDS,
  STATUS_LINE_PRESETS,
  STATUS_LINE_SEGMENT_IDS,
  type StatusLineSegmentId,
  statusLinePresetOf,
} from './statusLine';

describe('normalizeStatusLineSegments', () => {
  it('合法序列原样返回，且保序（顺序即渲染顺序，不得重排）', () => {
    const custom: StatusLineSegmentId[] = ['duration', 'model', 'context'];
    expect(normalizeStatusLineSegments(custom)).toEqual(custom);
  });

  it('空数组是有效状态「全部关闭」，⛔ 不能当损坏数据回默认', () => {
    expect(normalizeStatusLineSegments([])).toEqual([]);
  });

  it('非数组回默认 —— 这是崩在 .includes/.filter 上的那一类输入', () => {
    for (const bad of [null, undefined, 'model', 42, {}, { 0: 'model' }, true]) {
      expect(normalizeStatusLineSegments(bad)).toEqual([...DEFAULT_STATUS_LINE_SEGMENTS]);
    }
  });

  it('剔除非法 id —— 这是让设置弹层渲染 undefined 图标而白屏的那一类输入', () => {
    expect(normalizeStatusLineSegments(['model', 'nope', 'context', '__proto__'])).toEqual([
      'model',
      'context',
    ]);
  });

  it('剔除非字符串项，不抛异常', () => {
    expect(normalizeStatusLineSegments(['model', null, 7, {}, undefined, 'context'])).toEqual([
      'model',
      'context',
    ]);
  });

  it('按首次出现去重（重复项会产生重复 React key）', () => {
    expect(normalizeStatusLineSegments(['context', 'model', 'context'])).toEqual([
      'context',
      'model',
    ]);
  });

  it('全是非法项时返回空数组，而不是回默认 —— 输入是数组就尊重它的「显式选择」语义', () => {
    expect(normalizeStatusLineSegments(['nope', 'alsoNope'])).toEqual([]);
  });

  it('归一化后的结果必然能被 statusLinePresetOf 处理，不会抛', () => {
    expect(statusLinePresetOf(normalizeStatusLineSegments(undefined))).toBe('default');
    expect(statusLinePresetOf(normalizeStatusLineSegments(['nope']))).toBe('custom');
  });
});

describe('statusLinePresetOf', () => {
  it('三个预设各自被反推出来', () => {
    expect(statusLinePresetOf(STATUS_LINE_PRESETS.minimal)).toBe('minimal');
    expect(statusLinePresetOf(STATUS_LINE_PRESETS.default)).toBe('default');
    expect(statusLinePresetOf(STATUS_LINE_PRESETS.full)).toBe('full');
  });

  it('段位相同但顺序不同 → custom（顺序可拖拽，换序也是用户的自定义）', () => {
    expect(statusLinePresetOf(['context', 'model'])).toBe('custom');
    expect(statusLinePresetOf([...STATUS_LINE_PRESETS.default].reverse())).toBe('custom');
  });

  it('在预设基础上多开一段 → custom', () => {
    expect(statusLinePresetOf([...STATUS_LINE_PRESETS.minimal, 'cwd'])).toBe('custom');
  });

  it('在预设基础上关掉一段 → custom', () => {
    expect(statusLinePresetOf(STATUS_LINE_PRESETS.default.slice(1))).toBe('custom');
    expect(statusLinePresetOf(['model'])).toBe('custom');
  });

  it('全关 → custom，不是 minimal', () => {
    expect(statusLinePresetOf([])).toBe('custom');
  });

  it('段位数相同但成员不同 → custom（不能只比数量）', () => {
    const swapped: StatusLineSegmentId[] = ['model', 'cwd'];
    expect(swapped).toHaveLength(STATUS_LINE_PRESETS.minimal.length);
    expect(statusLinePresetOf(swapped)).toBe('custom');
  });
});

describe('reorderStatusLineSegments', () => {
  const base: readonly StatusLineSegmentId[] = ['model', 'context', 'turns', 'duration'];

  it('向后移动', () => {
    expect(reorderStatusLineSegments(base, 0, 2)).toEqual([
      'context',
      'turns',
      'model',
      'duration',
    ]);
  });

  it('向前移动', () => {
    expect(reorderStatusLineSegments(base, 3, 0)).toEqual([
      'duration',
      'model',
      'context',
      'turns',
    ]);
  });

  it('相邻交换', () => {
    expect(reorderStatusLineSegments(base, 1, 2)).toEqual([
      'model',
      'turns',
      'context',
      'duration',
    ]);
  });

  it('长度与成员守恒（只换顺序，不增删）', () => {
    const moved = reorderStatusLineSegments(base, 0, 3);
    expect(moved).toHaveLength(base.length);
    expect([...moved].sort()).toEqual([...base].sort());
  });

  it('原地不动返回原数组引用，调用方可据此跳过 set', () => {
    expect(reorderStatusLineSegments(base, 2, 2)).toBe(base);
  });

  it('越界返回原数组引用，不抛也不产生空洞', () => {
    expect(reorderStatusLineSegments(base, -1, 1)).toBe(base);
    expect(reorderStatusLineSegments(base, 0, 99)).toBe(base);
    expect(reorderStatusLineSegments(base, 99, 0)).toBe(base);
    expect(reorderStatusLineSegments([], 0, 0)).toEqual([]);
  });
});

describe('预设定义自身的约束', () => {
  it('default 预设即出厂默认值', () => {
    expect(DEFAULT_STATUS_LINE_SEGMENTS).toEqual(STATUS_LINE_PRESETS.default);
    expect(statusLinePresetOf(DEFAULT_STATUS_LINE_SEGMENTS)).toBe('default');
  });

  it('full 覆盖全部段位且同序 —— 将来新增段位漏加进 full 时这条会失败', () => {
    expect([...STATUS_LINE_PRESETS.full]).toEqual([...STATUS_LINE_SEGMENT_IDS]);
  });

  it('预设递进包含 minimal ⊂ default ⊂ full', () => {
    const inDefault = new Set<string>(STATUS_LINE_PRESETS.default);
    expect(STATUS_LINE_PRESETS.minimal.every((id) => inDefault.has(id))).toBe(true);
    const inFull = new Set<string>(STATUS_LINE_PRESETS.full);
    expect(STATUS_LINE_PRESETS.default.every((id) => inFull.has(id))).toBe(true);
  });

  it('每个预设里的段位都是合法段位 id 且无重复', () => {
    const valid = new Set<string>(STATUS_LINE_SEGMENT_IDS);
    for (const presetId of STATUS_LINE_PRESET_IDS) {
      const preset = STATUS_LINE_PRESETS[presetId];
      for (const id of preset) expect(valid.has(id)).toBe(true);
      expect(new Set(preset).size).toBe(preset.length);
    }
  });
});
