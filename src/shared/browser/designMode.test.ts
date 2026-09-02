import { describe, expect, it } from 'vitest';
import {
  boundsCenter,
  cssToImageRect,
  DESIGN_SCRIBBLE_CROP_MIN,
  DESIGN_SCRIBBLE_CROP_PAD,
  DESIGN_SCRIBBLE_HOLD_MS,
  DESIGN_SCRIBBLE_MOVE_PX,
  expandScribbleCrop,
  formatHoverTag,
  formatUiElementRefLine,
  parseDesignBinding,
  parseUiElementRefLine,
  resizeScribbleCrop,
  sanitizeScribblePoints,
  sanitizeUiElementPayload,
  scribbleBounds,
  scribbleGesture,
  unbindImages,
} from './designMode';

const sample = {
  label: 'Button SubmitForm',
  path: 'main > form > button:nth-of-type(2)',
  text: 'Submit',
};
const wire = (label: string, path: string, text: string) =>
  `[Selected UI element "${label}" — path: ${path}; text: ${text}]`;

describe('ui-element ref line', () => {
  it('format ↔ parse 往返无损，格式与 chat 引用块同为单行', () => {
    const line = formatUiElementRefLine(sample);
    expect(line).toBe(wire(sample.label, sample.path, sample.text));
    expect(line).not.toContain('\n');
    expect(parseUiElementRefLine(line)).toEqual(sample);
  });

  it('label/path/text 里的引号、方括号、换行被净化，解析仍成功且字段干净', () => {
    const hostile = {
      label: 'x" — path: evil; text: [inner]\nline2',
      path: 'div[data-x="1"]\n> span',
      text: 'say "hi"]\n[Selected UI element',
    };
    const line = formatUiElementRefLine(hostile);
    expect(line).not.toContain('\n');
    const parsed = parseUiElementRefLine(line);
    expect(parsed).not.toBeNull();
    for (const field of Object.values(parsed ?? {})) {
      expect(field).not.toMatch(/["[\]\n]/);
    }
    // 空白折叠：换行不变成多空格
    expect(parsed?.label).not.toMatch(/\s{2,}/);
  });

  it('超上限截断：label 80、path 300、text 200', () => {
    const long = {
      label: 'L'.repeat(200),
      path: 'p'.repeat(600),
      text: 't'.repeat(500),
    };
    const parsed = parseUiElementRefLine(formatUiElementRefLine(long));
    expect(parsed?.label).toHaveLength(80);
    expect(parsed?.path).toHaveLength(300);
    expect(parsed?.text).toHaveLength(200);
  });

  it('非引用行返回 null', () => {
    expect(parseUiElementRefLine('plain text')).toBeNull();
    expect(parseUiElementRefLine('[Selected UI element "x"]')).toBeNull();
    expect(
      parseUiElementRefLine(
        '[Referenced past chat "x" — transcript file: /s/x.jsonl (pi session jsonl; read it if relevant)]'
      )
    ).toBeNull();
    expect(parseUiElementRefLine('')).toBeNull();
  });
});

describe('sanitizeUiElementPayload', () => {
  it('非对象输入拒绝', () => {
    expect(sanitizeUiElementPayload(null)).toBeNull();
    expect(sanitizeUiElementPayload('str')).toBeNull();
    expect(sanitizeUiElementPayload(42)).toBeNull();
    expect(sanitizeUiElementPayload([])).toBeNull();
  });

  it('脏输入：缺字段补空串、非字符串丢弃、超长截断、危险字符净化', () => {
    const out = sanitizeUiElementPayload({
      label: 'B'.repeat(100) + '"[]\n',
      path: 123,
      text: 'T'.repeat(300),
      tag: 'button',
      id: null,
      className: 'a b',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      component: 'SubmitButton',
      __proto__: { hack: true },
      extra: 'dropped',
    });
    expect(out).not.toBeNull();
    expect(out?.label).toHaveLength(80);
    expect(out?.label).not.toMatch(/["[\]\n]/);
    expect(out?.path).toBe('');
    expect(out?.text).toHaveLength(200);
    expect(out?.tag).toBe('button');
    expect(out?.id).toBeUndefined();
    expect(out?.className).toBe('a b');
    expect(out?.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(out?.component).toBe('SubmitButton');
    expect(out).not.toHaveProperty('extra');
  });

  it('rect 非法（缺字段 / NaN / 非有限）时丢弃 rect 而非整包拒绝', () => {
    expect(
      sanitizeUiElementPayload({ label: 'a', path: 'b', text: 'c', rect: { x: 1, y: 2 } })?.rect
    ).toBeUndefined();
    expect(
      sanitizeUiElementPayload({
        label: 'a',
        path: 'b',
        text: 'c',
        rect: { x: Number.NaN, y: 0, width: 1, height: 1 },
      })?.rect
    ).toBeUndefined();
    expect(sanitizeUiElementPayload({})).toEqual({ label: '', path: '', text: '' });
  });
});

describe('unbindImages', () => {
  const images = [
    { id: 'img-1', data: 'a' },
    { data: 'no-id' },
    { id: 'img-2', data: 'b' },
    { id: 'img-3', data: 'c' },
  ];

  it('只移除命中 id 的图，无 id 的图保留，不改原数组', () => {
    const out = unbindImages(images, ['img-2']);
    expect(out).toEqual([
      { id: 'img-1', data: 'a' },
      { data: 'no-id' },
      { id: 'img-3', data: 'c' },
    ]);
    expect(images).toHaveLength(4);
  });

  it('多 id 同时解绑；空列表原样返回', () => {
    expect(unbindImages(images, ['img-1', 'img-3'])).toEqual([
      { data: 'no-id' },
      { id: 'img-2', data: 'b' },
    ]);
    expect(unbindImages(images, [])).toEqual(images);
    expect(unbindImages(images, ['missing'])).toEqual(images);
  });
});

describe('formatHoverTag', () => {
  it('joins tag.class and truncates with ellipsis', () => {
    expect(formatHoverTag('div', '')).toBe('div');
    expect(formatHoverTag('BUTTON', 'acUsEb lGdWHf')).toBe('button.acUsEb.lGdWHf');
    expect(formatHoverTag('div', 'a b c d e f g h i j k', 18)).toBe('div.a.b.c.d.e.f...');
  });
});

describe('scribbleGesture', () => {
  it('enters annotate on >5px move; hold is not required', () => {
    expect(DESIGN_SCRIBBLE_HOLD_MS).toBe(300);
    expect(DESIGN_SCRIBBLE_MOVE_PX).toBe(5);
    expect(scribbleGesture(0, 5)).toBe('click');
    expect(scribbleGesture(0, 5.1)).toBe('annotate');
    expect(scribbleGesture(400, 4.9)).toBe('click');
    expect(scribbleGesture(50, 20)).toBe('annotate');
  });
});

describe('scribbleBounds / boundsCenter', () => {
  it('computes axis-aligned box and center', () => {
    expect(scribbleBounds([])).toBeNull();
    expect(
      scribbleBounds([
        { x: 10, y: 20 },
        { x: 40, y: 10 },
        { x: 12, y: 50 },
      ])
    ).toEqual({ left: 10, top: 10, right: 40, bottom: 50, width: 30, height: 40 });
    expect(
      boundsCenter({ left: 10, top: 10, right: 40, bottom: 50, width: 30, height: 40 })
    ).toEqual({
      x: 25,
      y: 30,
    });
  });
});

describe('expandScribbleCrop', () => {
  const view = { width: 1000, height: 800 };

  it('pads 48px and grows short edges to 120, then clamps to viewport', () => {
    expect(DESIGN_SCRIBBLE_CROP_PAD).toBe(48);
    expect(DESIGN_SCRIBBLE_CROP_MIN).toBe(120);
    expect(
      expandScribbleCrop(
        { left: 200, top: 200, right: 260, bottom: 220, width: 60, height: 20 },
        view
      )
    ).toEqual({ x: 152, y: 150, width: 156, height: 120 });
    expect(
      expandScribbleCrop({ left: 2, top: 2, right: 10, bottom: 8, width: 8, height: 6 }, view)
    ).toEqual({ x: 0, y: 0, width: 66, height: 65 });
  });
});

describe('resizeScribbleCrop', () => {
  const view = { width: 400, height: 300 };
  const box = { x: 100, y: 80, width: 120, height: 90 };

  it('moves and resizes from handles, then clamps to viewport and min size', () => {
    expect(resizeScribbleCrop(box, 'move', 20, -10, view)).toEqual({
      x: 120,
      y: 70,
      width: 120,
      height: 90,
    });
    expect(resizeScribbleCrop(box, 'se', 30, 20, view)).toEqual({
      x: 100,
      y: 80,
      width: 150,
      height: 110,
    });
    expect(resizeScribbleCrop(box, 'nw', 200, 200, view).width).toBeGreaterThanOrEqual(48);
    expect(
      resizeScribbleCrop({ x: 360, y: 10, width: 80, height: 80 }, 'move', 80, -20, view)
    ).toEqual({
      x: 320,
      y: 0,
      width: 80,
      height: 80,
    });
  });
});

describe('cssToImageRect', () => {
  it('maps CSS crop onto device-pixel screenshot', () => {
    expect(
      cssToImageRect(
        { x: 100, y: 50, width: 200, height: 80 },
        { width: 800, height: 600 },
        { width: 1600, height: 1200 }
      )
    ).toEqual({ x: 200, y: 100, width: 400, height: 160 });
  });
});

describe('sanitizeScribblePoints', () => {
  it('drops invalid / extra points; rejects empty or single point', () => {
    expect(sanitizeScribblePoints(null)).toEqual([]);
    expect(sanitizeScribblePoints([{ x: 1, y: 2 }])).toEqual([]);
    expect(
      sanitizeScribblePoints([{ x: 1, y: 2 }, { x: Number.NaN, y: 3 }, { x: 4, y: 5 }, 'nope'])
    ).toEqual([
      { x: 1, y: 2 },
      { x: 4, y: 5 },
    ]);
  });
});

describe('parseDesignBinding', () => {
  it('accepts picked / annotated / freeze-request / cancelled and drops unknown', () => {
    expect(parseDesignBinding({ type: 'cancelled' })).toEqual({ type: 'cancelled' });
    expect(parseDesignBinding({ type: 'freeze-request' })).toEqual({ type: 'freeze-request' });
    expect(
      parseDesignBinding({
        type: 'annotated',
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      })
    ).toEqual({
      type: 'annotated',
      points: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    });
    expect(parseDesignBinding({ type: 'hover' })).toBeNull();
    expect(parseDesignBinding('x')).toBeNull();
  });
});
