import type { SerializedDockview } from 'dockview-react';
import { describe, expect, it } from 'vitest';
import { removeLayoutPanel, sanitizeSidePanelLayout } from './layoutSanitize';

const known = new Set(['terminal', 'browser', 'changes', 'files']);

describe('sanitizeSidePanelLayout', () => {
  it('removeLayoutPanel 摘掉一个面板，摘空了返回 undefined', () => {
    const layout = {
      grid: {
        root: {
          type: 'branch',
          data: [
            {
              type: 'leaf',
              data: { views: ['files', 'plugin:r:p'], activeView: 'plugin:r:p', id: 'g1' },
              size: 50,
            },
            {
              type: 'leaf',
              data: { views: ['plugin:t:c'], activeView: 'plugin:t:c', id: 'g2' },
              size: 50,
            },
          ],
          size: 100,
        },
        width: 100,
        height: 100,
        orientation: 'HORIZONTAL',
      },
      panels: {
        files: { id: 'files', contentComponent: 'files' },
        'plugin:r:p': { id: 'plugin:r:p', contentComponent: 'plugin' },
        'plugin:t:c': { id: 'plugin:t:c', contentComponent: 'plugin' },
      },
    } as unknown as SerializedDockview;
    const next = removeLayoutPanel(layout, 'plugin:r:p');
    expect(Object.keys(next?.panels ?? {})).toEqual(['files', 'plugin:t:c']);
    expect(next?.grid.root).toMatchObject({
      data: [
        { data: { views: ['files'], activeView: 'files' } },
        { data: { views: ['plugin:t:c'] } },
      ],
    });
    expect(removeLayoutPanel(removeLayoutPanel(next, 'files'), 'plugin:t:c')).toBeUndefined();
    expect(removeLayoutPanel(layout, 'missing')).toBe(layout);
  });

  it('removeLayoutPanel 摘掉激活标签时选相邻的，优先左边', () => {
    const layout = (views: string[], activeView: string) =>
      ({
        grid: { root: { type: 'leaf', data: { views, activeView, id: 'g1' }, size: 100 } },
        panels: Object.fromEntries(views.map((id) => [id, { id, contentComponent: 'plugin' }])),
      }) as unknown as SerializedDockview;
    expect(
      removeLayoutPanel(layout(['files', 't1', 'plugin:g:w', 'b1'], 'plugin:g:w'), 'plugin:g:w')
        ?.grid.root
    ).toMatchObject({ data: { views: ['files', 't1', 'b1'], activeView: 't1' } });
    expect(
      removeLayoutPanel(layout(['plugin:g:w', 'files', 't1'], 'plugin:g:w'), 'plugin:g:w')?.grid
        .root
    ).toMatchObject({ data: { views: ['files', 't1'], activeView: 'files' } });
  });

  it('returns undefined for dirty layouts', () => {
    expect(sanitizeSidePanelLayout(undefined, known)).toBeUndefined();
    expect(sanitizeSidePanelLayout(null, known)).toBeUndefined();
    expect(sanitizeSidePanelLayout('wide', known)).toBeUndefined();
    expect(sanitizeSidePanelLayout({ panels: [] }, known)).toBeUndefined();
  });

  it('drops unknown panels and their grid views', () => {
    const sanitized = sanitizeSidePanelLayout(
      {
        grid: {
          root: {
            type: 'branch',
            data: [
              {
                type: 'leaf',
                data: {
                  views: ['t1', 'btw:1', 'browser:1'],
                  activeView: 'btw:1',
                  id: 'g1',
                },
                size: 100,
              },
            ],
            size: 100,
          },
          width: 100,
          height: 100,
          orientation: 'HORIZONTAL',
        },
        panels: {
          t1: { id: 't1', contentComponent: 'terminal' },
          'btw:1': { id: 'btw:1', contentComponent: 'btw' },
          'browser:1': { id: 'browser:1', contentComponent: 'browser' },
        },
        activeGroup: 'g1',
      },
      known
    );
    expect(sanitized?.panels).toEqual({
      t1: { id: 't1', contentComponent: 'terminal' },
      'browser:1': { id: 'browser:1', contentComponent: 'browser' },
    });
    expect(sanitized?.grid).toEqual({
      root: {
        type: 'branch',
        data: [
          {
            type: 'leaf',
            data: {
              views: ['t1', 'browser:1'],
              activeView: 't1',
              id: 'g1',
            },
            size: 100,
          },
        ],
        size: 100,
      },
      width: 100,
      height: 100,
      orientation: 'HORIZONTAL',
    });
  });

  it('returns undefined when nothing known remains', () => {
    expect(
      sanitizeSidePanelLayout(
        {
          grid: {
            root: {
              type: 'branch',
              data: [
                {
                  type: 'leaf',
                  data: { views: ['btw:1'], activeView: 'btw:1', id: 'g1' },
                  size: 100,
                },
              ],
              size: 100,
            },
            width: 100,
            height: 100,
            orientation: 'HORIZONTAL',
          },
          panels: { 'btw:1': { id: 'btw:1', contentComponent: 'btw' } },
        },
        known
      )
    ).toBeUndefined();
  });

  it('旧布局里已合并的秘书面板被丢掉，不阻断恢复', () => {
    const sanitized = sanitizeSidePanelLayout(
      {
        grid: {
          root: {
            type: 'branch',
            data: [
              {
                type: 'leaf',
                data: {
                  views: ['secretary-board', 'secretary-memory', 'secretary'],
                  activeView: 'secretary-board',
                  id: 'g1',
                },
                size: 100,
              },
            ],
            size: 100,
          },
          width: 100,
          height: 100,
          orientation: 'HORIZONTAL',
        },
        panels: {
          'secretary-board': { id: 'secretary-board', contentComponent: 'secretaryBoard' },
          'secretary-memory': { id: 'secretary-memory', contentComponent: 'secretaryMemory' },
          secretary: { id: 'secretary', contentComponent: 'secretary' },
        },
      },
      new Set(['secretary'])
    );
    expect(Object.keys(sanitized?.panels ?? {})).toEqual(['secretary']);
    const grid = JSON.stringify(sanitized?.grid);
    expect(grid).toContain('"secretary"');
    expect(grid).not.toContain('secretary-board');
  });
});
