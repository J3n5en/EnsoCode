import { describe, expect, it } from 'vitest';
import { parseWorkspaceSearchQueryRequest } from './workspaceSearchQuery';

describe('parseWorkspaceSearchQueryRequest', () => {
  it('收窄合法请求', () => {
    expect(
      parseWorkspaceSearchQueryRequest({
        query: 'term',
        currentProjectId: 'proj-a',
        scope: 'project',
      })
    ).toEqual({ query: 'term', currentProjectId: 'proj-a', scope: 'project' });
  });

  it('拒绝脏输入与多余路径字段不能冒充合法请求', () => {
    expect(parseWorkspaceSearchQueryRequest(null)).toBeNull();
    expect(
      parseWorkspaceSearchQueryRequest({ query: 1, currentProjectId: 'p', scope: 'project' })
    ).toBeNull();
    expect(
      parseWorkspaceSearchQueryRequest({ query: 'x', currentProjectId: '', scope: 'project' })
    ).toBeNull();
    expect(
      parseWorkspaceSearchQueryRequest({ query: 'x', currentProjectId: 'p', scope: 'everything' })
    ).toBeNull();
  });
});
