import { archivedTotal, archiveScopeForTab, filterArchivedByScope } from '@shared/archiveScope';
import { ALL_GROUP_ID, RECENT_GROUP_ID, UNGROUPED_GROUP_ID } from '@shared/projectGroups';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ArchiveEntryButton } from './ArchiveEntryButton';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const render = (count: number) =>
  renderToStaticMarkup(createElement(ArchiveEntryButton, { count, onClick: () => {} }));

describe('ArchiveEntryButton', () => {
  const projectGroups = [{ id: 'g1' }, { id: 'g2' }];
  const ctx = {
    projects: [{ id: 'p1', groupId: 'g1' }],
    projectGroups,
    conversations: { a: {}, b: {} },
  };
  const groups = [{ projectId: 'p1', ids: ['a', 'b'] }];

  it.each([
    [ALL_GROUP_ID, 2],
    [RECENT_GROUP_ID, 2],
    ['g1', 2],
    ['g2', 0],
    [UNGROUPED_GROUP_ID, 0],
  ])('tab %s 都渲染入口并显示该范围的数量', (tab, expected) => {
    const scope = archiveScopeForTab(tab, projectGroups);
    const count = archivedTotal(filterArchivedByScope(groups, scope, ctx));
    expect(count).toBe(expected);
    const html = render(count);
    expect(html).toContain('data-slot="archived-button"');
    if (expected > 0) expect(html).toContain(`>${expected}</span>`);
  });

  it('0 条时仍渲染，弱化且不带数字', () => {
    const html = render(0);
    expect(html).toContain('data-slot="archived-button"');
    expect(html).toContain('data-empty="true"');
    expect(html).not.toContain('data-slot="archived-count"');
  });

  it('超过 99 条显示 99+', () => {
    expect(render(120)).toContain('>99+</span>');
  });
});
