import { describe, expect, it } from 'vitest';
import {
  skyClickCgEventType,
  skyClickEventRecipe,
  skyClickLocalPoint,
  skyClickWindowMatchesTarget,
  skyDragPath,
  skyDragRecipe,
  skyLightActivationRecord,
  skyLightKeyWindowRecords,
  skyPointerClickRecipe,
} from './skyClick';

describe('skyClickEventRecipe', () => {
  it('单击：先 target move，再 (-1,-1) primer，再真正 down/up', () => {
    expect(skyClickEventRecipe(1)).toEqual([
      { kind: 'moved', pointKind: 'target', clickState: 0, phase: 2, delayAfterMs: 15 },
      { kind: 'down', pointKind: 'primer', clickState: 1, phase: 1, delayAfterMs: 1 },
      { kind: 'up', pointKind: 'primer', clickState: 1, phase: 2, delayAfterMs: 100 },
      { kind: 'down', pointKind: 'target', clickState: 1, phase: 3, delayAfterMs: 1 },
      { kind: 'up', pointKind: 'target', clickState: 1, phase: 3, delayAfterMs: 0 },
    ]);
  });

  it('只接受 1 或 2 击', () => {
    expect(() => skyClickEventRecipe(3)).toThrow(/click_count/);
    expect(
      skyClickEventRecipe(2).filter((step) => step.pointKind === 'target' && step.kind !== 'moved')
    ).toHaveLength(4);
  });
});

describe('skyPointerClickRecipe', () => {
  it('左键与 skyClickEventRecipe 一致（带 primer）', () => {
    expect(skyPointerClickRecipe({ button: 'left', count: 1 })).toEqual(skyClickEventRecipe(1));
  });

  it('左键三击：primer 之后三组 down/up，clickState 递增', () => {
    const target = skyPointerClickRecipe({ button: 'left', count: 3 }).filter(
      (step) => step.pointKind === 'target' && step.kind !== 'moved'
    );
    expect(target.map((step) => `${step.kind}${step.clickState}`)).toEqual([
      'down1',
      'up1',
      'down2',
      'up2',
      'down3',
      'up3',
    ]);
  });

  it('右键/中键不发左键 primer，避免在目标里多出一次左键', () => {
    for (const button of ['right', 'middle'] as const) {
      const steps = skyPointerClickRecipe({ button, count: 1 });
      expect(steps.some((step) => step.pointKind === 'primer')).toBe(false);
      expect(steps.map((step) => step.kind)).toEqual(['moved', 'down', 'up']);
    }
  });

  it('按按钮解析 CG 事件类型', () => {
    expect(skyClickCgEventType('down', 'right')).toBe(3);
    expect(skyClickCgEventType('up', 'right')).toBe(4);
    expect(skyClickCgEventType('dragged', 'left')).toBe(6);
    expect(skyClickCgEventType('down', 'middle')).toBe(25);
    expect(skyClickCgEventType('moved')).toBe(5);
  });

  it('拒绝非法次数', () => {
    expect(() => skyPointerClickRecipe({ button: 'left', count: 0 })).toThrow();
    expect(() => skyPointerClickRecipe({ button: 'left', count: 4 })).toThrow();
  });
});

describe('skyDragPath', () => {
  it('长线段按步长插值，首尾保持原点', () => {
    const path = skyDragPath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      25
    );
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 25, y: 0 },
      { x: 50, y: 0 },
      { x: 75, y: 0 },
      { x: 100, y: 0 },
    ]);
  });

  it('单点与重复点不插值', () => {
    expect(skyDragPath([{ x: 3, y: 4 }], 10)).toEqual([{ x: 3, y: 4 }]);
    expect(
      skyDragPath(
        [
          { x: 3, y: 4 },
          { x: 3, y: 4 },
        ],
        10
      )
    ).toEqual([
      { x: 3, y: 4 },
      { x: 3, y: 4 },
    ]);
  });
});

describe('skyDragRecipe', () => {
  it('move → primer → down(首点) → dragged(中间与末点) → up(末点)', () => {
    const steps = skyDragRecipe(3);
    expect(steps.map((step) => `${step.kind}:${step.pointKind}:${step.pointIndex ?? '-'}`)).toEqual(
      [
        'moved:target:0',
        'down:primer:-',
        'up:primer:-',
        'down:target:0',
        'dragged:target:1',
        'dragged:target:2',
        'up:target:2',
      ]
    );
    expect(
      steps
        .filter((step) => step.kind !== 'moved' && step.pointKind === 'target')
        .every((step) => step.clickState === 1)
    ).toBe(true);
  });

  it('至少两个点', () => {
    expect(() => skyDragRecipe(1)).toThrow();
  });
});

describe('skyLightKeyWindowRecords', () => {
  it('两条 0xF8 记录（0x01 再 0x02），带窗口号、0x3a=0x10 与 0x20–0x2f 全 0xff', () => {
    const records = skyLightKeyWindowRecords(0x01020304);
    expect(records.map((record) => record[0x08])).toEqual([0x01, 0x02]);
    for (const record of records) {
      expect(record).toHaveLength(0xf8);
      expect(record[0x04]).toBe(0xf8);
      expect(record[0x3a]).toBe(0x10);
      expect([...record.slice(0x20, 0x30)].every((byte) => byte === 0xff)).toBe(true);
      expect([...record.slice(0x3c, 0x40)]).toEqual([0x04, 0x03, 0x02, 0x01]);
    }
  });
});

describe('skyLightActivationRecord', () => {
  it('0xF8 字节，写入 windowID 和 focused 标记', () => {
    const focused = skyLightActivationRecord(0x12345678, true);
    expect(focused).toHaveLength(0xf8);
    expect(focused[0x04]).toBe(0xf8);
    expect(focused[0x08]).toBe(0x0d);
    expect(focused[0x3c]).toBe(0x78);
    expect(focused[0x3d]).toBe(0x56);
    expect(focused[0x3e]).toBe(0x34);
    expect(focused[0x3f]).toBe(0x12);
    expect(focused[0x8a]).toBe(0x01);
    expect(skyLightActivationRecord(1, false)[0x8a]).toBe(0x02);
  });
});

describe('skyClickLocalPoint', () => {
  it('屏幕坐标换成窗口内坐标', () => {
    expect(skyClickLocalPoint({ x: 120, y: 80 }, { x: 100, y: 50, width: 40, height: 40 })).toEqual(
      {
        x: 20,
        y: 30,
      }
    );
  });
});

describe('skyClickWindowMatchesTarget', () => {
  it('要求同 pid、同 windowID 且在屏上', () => {
    const windows = [{ id: '9', pid: 42, onScreen: true }];
    expect(skyClickWindowMatchesTarget(windows, 9, 42)).toBe(true);
    expect(skyClickWindowMatchesTarget(windows, 9, 41)).toBe(false);
    expect(skyClickWindowMatchesTarget([{ id: '9', pid: 42, onScreen: false }], 9, 42)).toBe(false);
  });
});
