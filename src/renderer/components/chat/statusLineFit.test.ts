import type { StatusLineSegmentId } from '@shared/statusLine';
import { describe, expect, it } from 'vitest';
import { fitStatusLine, STATUS_LINE_GAP_PX } from './statusLineFit';

const segments: StatusLineSegmentId[] = ['model', 'tokens', 'cache', 'context', 'turns', 'speed'];
const widths = { model: 200, tokens: 90, cache: 45, context: 100, turns: 40, speed: 80 };
const pinnedWidth = 200 + 90 + 45 + 100 + 3 * STATUS_LINE_GAP_PX;
const allWidth = pinnedWidth + 40 + 80 + 2 * STATUS_LINE_GAP_PX;
const trigger = 44;

const widthOf = (ids: StatusLineSegmentId[]) =>
  ids.reduce((sum, id) => sum + widths[id as keyof typeof widths], 0) +
  Math.max(0, ids.length - 1) * STATUS_LINE_GAP_PX;

describe('fitStatusLine', () => {
  it('手机布局只留详情按钮', () => {
    expect(fitStatusLine({ segments, widths, available: 2000, summaryOnly: true })).toEqual({
      inline: [],
      hoverable: [],
      collapsed: true,
    });
  });

  it('未测量或放得下时与桌面原排布一致', () => {
    const desktop = {
      inline: ['model', 'tokens', 'cache', 'context'],
      hoverable: ['turns', 'speed'],
      collapsed: false,
    };
    expect(fitStatusLine({ segments, summaryOnly: false })).toEqual(desktop);
    expect(
      fitStatusLine({
        segments,
        widths,
        available: allWidth,
        triggerWidth: trigger,
        summaryOnly: false,
      })
    ).toEqual(desktop);
  });

  it('悬停段只展开放得下的前缀', () => {
    const fit = fitStatusLine({
      segments,
      widths,
      available: pinnedWidth + STATUS_LINE_GAP_PX + 40,
      triggerWidth: trigger,
      summaryOnly: false,
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
      summaryOnly: false,
    });
    expect(fit).toEqual({ inline: ['model', 'tokens'], hoverable: [], collapsed: true });

    for (let available = 0; available <= allWidth + 50; available += 7) {
      const result = fitStatusLine({
        segments,
        widths,
        available,
        triggerWidth: trigger,
        summaryOnly: false,
      });
      const used = result.collapsed
        ? widthOf(result.inline) + (result.inline.length > 0 ? STATUS_LINE_GAP_PX : 0) + trigger
        : widthOf([...result.inline, ...result.hoverable]);
      if (result.inline.length > 0) expect(used).toBeLessThanOrEqual(available);
      expect(result.inline).toEqual(segments.slice(0, result.inline.length));
    }
  });
});
