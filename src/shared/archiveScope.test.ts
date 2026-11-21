import { ALL_GROUP_ID, RECENT_GROUP_ID, UNGROUPED_GROUP_ID } from '@shared/projectGroups';
import { describe, expect, it } from 'vitest';
import {
  archivedTotal,
  archiveScopeForTab,
  archiveSecretaryIds,
  filterArchivedByScope,
} from './archiveScope';

const projectGroups = [{ id: 'g1' }, { id: 'g2' }];
const projects = [
  { id: 'p1', groupId: 'g1' },
  { id: 'p2', groupId: 'g2' },
  { id: 'p3' },
  { id: 'p4', groupId: 'gone' },
];
const conversations = {
  a: {},
  b: { secretaryOrigin: { secretaryConversationId: 's', secretaryId: 'sec-2' } },
  c: { secretaryOrigin: { secretaryConversationId: 's' } },
  d: {},
  e: {},
  f: {},
};
const groups = [
  { projectId: 'p1', ids: ['a', 'b'] },
  { projectId: 'p2', ids: ['c'] },
  { projectId: 'p3', ids: ['d'] },
  { projectId: 'p4', ids: ['e'], projectArchived: true as const },
  { projectId: 'deleted', ids: ['f'] },
];
const ctx = { projects, projectGroups, conversations };
const ids = (scope: Parameters<typeof filterArchivedByScope>[1]) =>
  filterArchivedByScope(groups, scope, ctx).flatMap((group) => group.ids);

describe('archiveScopeForTab', () => {
  it('每个 tab 都映射到一个范围', () => {
    expect(archiveScopeForTab(ALL_GROUP_ID, projectGroups)).toEqual({ kind: 'all' });
    expect(archiveScopeForTab(RECENT_GROUP_ID, projectGroups)).toEqual({
      kind: 'all',
      fallbackFrom: 'recent',
    });
    expect(archiveScopeForTab(UNGROUPED_GROUP_ID, projectGroups)).toEqual({ kind: 'ungrouped' });
    expect(archiveScopeForTab('g2', projectGroups)).toEqual({ kind: 'group', groupId: 'g2' });
    expect(archiveScopeForTab('missing', projectGroups)).toEqual({ kind: 'all' });
  });
});

describe('filterArchivedByScope', () => {
  it('全部 / 最近列出全部归档', () => {
    expect(ids({ kind: 'all' })).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(ids(archiveScopeForTab(RECENT_GROUP_ID, projectGroups))).toHaveLength(6);
  });

  it('分组 tab 只列该分组项目的归档', () => {
    expect(ids({ kind: 'group', groupId: 'g1' })).toEqual(['a', 'b']);
    expect(ids({ kind: 'group', groupId: 'g2' })).toEqual(['c']);
  });

  it('未分组 tab 含无分组、分组已删和项目已删的归档', () => {
    expect(ids({ kind: 'ungrouped' })).toEqual(['d', 'e', 'f']);
  });

  it('秘书范围只列该秘书派出的归档会话，缺省 id 归默认秘书', () => {
    expect(ids({ kind: 'secretary', secretaryId: 'sec-2' })).toEqual(['b']);
    expect(ids({ kind: 'secretary', secretaryId: 'default' })).toEqual(['c']);
    expect(filterArchivedByScope(groups, { kind: 'secretary', secretaryId: 'none' }, ctx)).toEqual(
      []
    );
  });
});

describe('archivedTotal / archiveSecretaryIds', () => {
  it('按范围计数，0 条也能算出来', () => {
    expect(archivedTotal(filterArchivedByScope(groups, { kind: 'all' }, ctx))).toBe(6);
    expect(archivedTotal(filterArchivedByScope(groups, { kind: 'group', groupId: 'x' }, ctx))).toBe(
      0
    );
  });

  it('列出有归档派出会话的秘书', () => {
    expect(archiveSecretaryIds(groups, conversations)).toEqual(['sec-2', 'default']);
  });
});
