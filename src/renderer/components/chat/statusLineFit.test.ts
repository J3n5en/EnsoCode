import { STATUS_LINE_PRESETS, type StatusLineSegmentId } from '@shared/statusLine';
import { describe, expect, it } from 'vitest';
import { fitStatusLine, STATUS_LINE_GAP_PX, statusLineLayoutSegments } from './statusLineFit';

const segments: StatusLineSegmentId[] = ['model', 'tokens', 'cache', 'context', 'turns', 'speed'];
const widths = { model: 200, tokens: 90, cache: 45, context: 100, turns: 40, speed: 80 };
const pinnedWidth = 200 + 90 + 45 + 100 + 3 * STATUS_LINE_GAP_PX;
const allWidth = pinnedWidth + 40 + 80 + 2 * STATUS_LINE_GAP_PX;
const trigger = 44;

const widthOf = (ids: StatusLineSegmentId[]) =>
  ids.reduce((sum, id) => sum + widths[id as keyof typeof widths], 0) +
  Math.max(0, ids.length - 1) * STATUS_LINE_GAP_PX;

describe('fitStatusLine', () => {
  it('未测量或放得下时与桌面原排布一致', () => {
    const desktop = {
      inline: ['model', 'tokens', 'cache', 'context'],
      hoverable: ['turns', 'speed'],
      collapsed: false,
    };
    expect(fitStatusLine({ segments, mobile: false })).toEqual(desktop);
    expect(
      fitStatusLine({
        segments,
        widths,
        available: allWidth,
        triggerWidth: trigger,
        mobile: false,
      })
    ).toEqual(desktop);
  });

  it('悬停段只展开放得下的前缀', () => {
    const fit = fitStatusLine({
      segments,
      widths,
      available: pinnedWidth + STATUS_LINE_GAP_PX + 40,
      triggerWidth: trigger,
      mobile: false,
    });
    expect(fit).toEqual({
      inline: ['model', 'tokens', 'cache', 'context'],
      hoverable: ['turns'],
      collapsed: false,
    });
  });

  it('中等宽度逐项收起，留下的段加详情按钮从不超宽', () => {
    const fit = fitStatusLine({
      segments,
      widths,
      available: 200 + 90 + 2 * STATUS_LINE_GAP_PX + trigger,
      triggerWidth: trigger,
      mobile: false,
    });
    expect(fit).toEqual({ inline: ['model', 'tokens'], hoverable: [], collapsed: true });

    for (let available = 0; available <= allWidth + 50; available += 7) {
      const result = fitStatusLine({
        segments,
        widths,
        available,
        triggerWidth: trigger,
        mobile: false,
      });
      const used = result.collapsed
        ? widthOf(result.inline) + (result.inline.length > 0 ? STATUS_LINE_GAP_PX : 0) + trigger
        : widthOf([...result.inline, ...result.hoverable]);
      if (result.inline.length > 0) expect(used).toBeLessThanOrEqual(available);
      expect(result.inline).toEqual(segments.slice(0, result.inline.length));
    }
  });
});

describe('fitStatusLine 手机布局', () => {
  const mobileSegments = statusLineLayoutSegments(STATUS_LINE_PRESETS.default, true);
  const mobileWidths = {
    tokens: 72,
    cache: 42,
    context: 96,
    requestBody: 58,
    turns: 36,
    speed: 64,
    duration: 70,
    sessionTime: 40,
  };
  const more = 26;
  const fitAt = (available: number, ids: readonly StatusLineSegmentId[] = mobileSegments) =>
    fitStatusLine({
      segments: ids,
      widths: mobileWidths,
      available,
      triggerWidth: trigger,
      moreWidth: more,
      mobile: true,
    });
  const span = (ids: StatusLineSegmentId[]) =>
    ids.reduce((sum, id) => sum + mobileWidths[id as keyof typeof mobileWidths], 0) +
    Math.max(0, ids.length - 1) * STATUS_LINE_GAP_PX;

  it('默认段位在手机上不重复显示模型，改过段位就按设置来', () => {
    expect(mobileSegments).not.toContain('model');
    expect(statusLineLayoutSegments(STATUS_LINE_PRESETS.default, false)).toContain('model');
    const reEnabled = [...STATUS_LINE_PRESETS.default.filter((id) => id !== 'model'), 'model'];
    expect(statusLineLayoutSegments(reEnabled as StatusLineSegmentId[], true)).toContain('model');
    expect(statusLineLayoutSegments(STATUS_LINE_PRESETS.minimal, true)).toEqual([
      'model',
      'context',
    ]);
  });

  it('390 宽放得下的 token、缓存、上下文都显示，其余收进详情', () => {
    expect(fitAt(310)).toEqual({
      inline: ['tokens', 'cache', 'context'],
      hoverable: [],
      collapsed: true,
    });
  });

  it('全部放得下时不出详情按钮，也没有悬停段', () => {
    expect(fitAt(span([...mobileSegments]))).toEqual({
      inline: [...mobileSegments],
      hoverable: [],
      collapsed: false,
    });
  });

  it('更窄时逐项收起，上下文始终在，留下的段加更多按钮从不超宽', () => {
    expect(fitAt(240).inline).toEqual(['tokens', 'context']);
    expect(fitAt(150).inline).toEqual(['context']);
    // 连上下文加更多按钮都放不下：行内清空，由详情按钮显示上下文百分比
    expect(fitAt(120)).toEqual({ inline: [], hoverable: [], collapsed: true });

    const contextLast: StatusLineSegmentId[] = ['tokens', 'cache', 'turns', 'context'];
    let previous = Number.POSITIVE_INFINITY;
    for (let available = 600; available >= 0; available -= 5) {
      for (const ids of [mobileSegments, contextLast]) {
        const result = fitAt(available, ids);
        if (!result.collapsed) continue;
        if (result.inline.length > 0) {
          expect(result.inline).toContain('context');
          expect(span(result.inline) + STATUS_LINE_GAP_PX + more).toBeLessThanOrEqual(available);
        }
        expect(result.inline).toEqual(ids.filter((id) => result.inline.includes(id)));
      }
      const count = fitAt(available).inline.length;
      expect(count).toBeLessThanOrEqual(previous);
      previous = count;
    }
  });
});
