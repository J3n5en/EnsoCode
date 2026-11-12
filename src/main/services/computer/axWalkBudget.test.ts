import type { AxTreeNode } from '@shared/computer/axTree';
import { describe, expect, it } from 'vitest';
import {
  AX_SNAPSHOT_BUDGET_MS,
  AX_WORKER_TIMEOUT_MS,
  axChildTraversalAttributes,
  axCollectVisibleText,
  axFillEmptyRowTitle,
  axKeepPartialOnTimeout,
  axNextDepth,
  axNodeMatchesQuery,
  axQueryShouldExpand,
  axRowTitleFromCells,
  axShouldExpand,
  axWalkDecision,
} from './axWalkBudget';

describe('axWalkDecision', () => {
  it('worker 超时长于遍历预算，预算到点能先返回部分树', () => {
    expect(AX_WORKER_TIMEOUT_MS).toBeGreaterThan(AX_SNAPSHOT_BUDGET_MS);
  });

  it('超时和节点预算分开', () => {
    expect(axWalkDecision({ startedAt: 0, nodeCount: 1, now: 2500 })).toBe('timeout');
    expect(axWalkDecision({ startedAt: 0, nodeCount: 80, now: 10 })).toBe('budget');
    expect(axWalkDecision({ startedAt: 0, nodeCount: 2, now: 10 })).toBe('continue');
  });

  it('超时时若已有节点则保留部分树', () => {
    expect(axKeepPartialOnTimeout(0)).toBe(false);
    expect(axKeepPartialOnTimeout(3)).toBe(true);
  });
});

describe('ax walk depth', () => {
  it('Group/ScrollArea 不占深度，Outline 会展开到行', () => {
    expect(axNextDepth('AXGroup', 1)).toBe(1);
    expect(axNextDepth('AXSplitGroup', 1)).toBe(1);
    expect(axNextDepth('AXScrollArea', 1)).toBe(1);
    expect(axNextDepth('AXButton', 1)).toBe(2);
    expect(axShouldExpand('AXWindow', 0, 1)).toBe(true);
    expect(axShouldExpand('AXGroup', 1, 1)).toBe(true);
    expect(axShouldExpand('AXOutline', 1, 1)).toBe(true);
    expect(axShouldExpand('AXTable', 1, 1)).toBe(true);
    expect(axShouldExpand('AXPopUpButton', 2, 1)).toBe(true);
    expect(axShouldExpand('AXMenuButton', 2, 1)).toBe(true);
    expect(axShouldExpand('AXButton', 1, 1)).toBe(false);
    expect(axShouldExpand('AXRow', 2, 1)).toBe(false);
    expect(axShouldExpand('AXSheet', 1, 1)).toBe(true);
    expect(axNextDepth('AXSheet', 1)).toBe(1);
  });

  it('Row 无自身 title 时用 cell 文本', () => {
    expect(axRowTitleFromCells(undefined, undefined, ['EnsoCode', '12.3', '482'])).toBe(
      'EnsoCode 12.3 482'
    );
    expect(axRowTitleFromCells('已有', undefined, ['EnsoCode'])).toBeUndefined();
  });
});

describe('empty AXRow labels', () => {
  it('从嵌套 StaticText 抽出侧栏可见字', () => {
    const row: AxTreeNode = {
      ref: 'e9',
      role: 'AXRow',
      children: [
        {
          ref: 'e10',
          role: 'AXCell',
          children: [
            {
              ref: 'e11',
              role: 'AXGroup',
              children: [{ ref: 'e12', role: 'AXStaticText', value: '外观' }],
            },
          ],
        },
      ],
    };
    expect(axCollectVisibleText(row)).toEqual(['外观']);
    axFillEmptyRowTitle(row);
    expect(row.title).toBe('外观');
  });
});

describe('axNodeMatchesQuery', () => {
  it('按 description 命中外观深色按钮', () => {
    expect(
      axNodeMatchesQuery({ role: 'AXButton', description: '深色' }, { description: '深色' })
    ).toBe(true);
    expect(
      axNodeMatchesQuery({ role: 'AXButton', description: '浅色' }, { description: '深色' })
    ).toBe(false);
    expect(
      axNodeMatchesQuery({ role: 'AXRadioButton', title: '浅色' }, { description: '浅色' })
    ).toBe(true);
  });

  it('find 不钻进侧栏 Outline/Row', () => {
    expect(axQueryShouldExpand('AXOutline')).toBe(false);
    expect(axQueryShouldExpand('AXRow')).toBe(false);
    expect(axQueryShouldExpand('AXList')).toBe(true);
    expect(axQueryShouldExpand('AXGroup')).toBe(true);
    expect(axQueryShouldExpand('AXButton')).toBe(true);
  });
});

describe('axChildTraversalAttributes', () => {
  it('普通 Group 会读 AXChildren 和 AXContents', () => {
    expect(axChildTraversalAttributes({ role: 'AXGroup' })).toEqual([
      'AXChildren',
      'AXRows',
      'AXContents',
      'AXVisibleChildren',
    ]);
  });

  it('Outline 有 Rows 时不重复扫 AXChildren', () => {
    expect(axChildTraversalAttributes({ role: 'AXOutline', hasRows: true })).toEqual([
      'AXRows',
      'AXContents',
      'AXVisibleChildren',
    ]);
  });

  it('List 有 VisibleChildren 时以可见子节点为主', () => {
    expect(axChildTraversalAttributes({ role: 'AXList', hasVisibleChildren: true })).toEqual([
      'AXRows',
      'AXContents',
      'AXVisibleChildren',
    ]);
  });
});
