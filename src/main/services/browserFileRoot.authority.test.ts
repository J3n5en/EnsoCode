import { expect, it } from 'vitest';
import * as policy from './browserFileRoot';

it('仅可信活动本地会话解析 cwd，拒绝错配 worktree', () => {
  expect(policy).toHaveProperty('pickBrowserFileRoot');
  const pick = (policy as unknown as { pickBrowserFileRoot: (input: unknown) => string | null })
    .pickBrowserFileRoot;
  const conversation = { projectId: 'p', lifecycle: 'active' };
  const project = { projectId: 'p', state: 'active', kind: 'local', canonicalPath: '/repo' };
  expect(pick({ conversation, project })).toBe('/repo');
  expect(pick({ conversation, project: { ...project, kind: undefined } })).toBe('/repo');
  expect(pick({ project })).toBeNull();
  expect(pick({ conversation, project: { ...project, kind: 'ssh' } })).toBeNull();
  expect(pick({ conversation, project: { ...project, state: 'archived' } })).toBeNull();
  expect(pick({ conversation, project: { ...project, projectId: 'other' } })).toBeNull();
  expect(
    pick({ conversation, project, worktree: { projectId: 'other', path: '/other' } })
  ).toBeNull();
  expect(pick({ conversation, project, worktree: { projectId: 'p', path: '/worktree' } })).toBe(
    '/worktree'
  );
});
