import { describe, expect, it } from 'vitest';
import {
  applyUsageProjectAliases,
  buildUsageProjectAliases,
  usageProjectLabel,
} from './projectLabel';

const projects = [{ id: 'proj-uuid', name: 'enso-code', path: '/Users/x/project/enso-code' }];
const worktrees = [
  {
    path: '/Users/x/Library/Application Support/enso-code/worktrees/proj-uuid/3085e88f',
    projectId: 'proj-uuid',
    repoPath: '/Users/x/project/enso-code',
  },
];

describe('usageProjectLabel', () => {
  const aliases = buildUsageProjectAliases({ projects, worktrees });

  it('主工作树 cwd 仍用项目名', () => {
    expect(usageProjectLabel('enso-code', '/Users/x/project/enso-code', aliases)).toBe('enso-code');
  });

  it('Enso worktree cwd 归到主项目，而不是会话短 id', () => {
    expect(
      usageProjectLabel(
        '3085e88f',
        '/Users/x/Library/Application Support/enso-code/worktrees/proj-uuid/3085e88f',
        aliases
      )
    ).toBe('enso-code');
  });

  it('账本只剩短 id、没有 cwd 时，也能按 worktree 叶子名归并', () => {
    expect(usageProjectLabel('3085e88f', undefined, aliases)).toBe('enso-code');
  });

  it('没有别名时保持 basename', () => {
    expect(usageProjectLabel('3085e88f', '/tmp/3085e88f')).toBe('3085e88f');
  });

  it('回填 session 与 records 的 project', () => {
    const remapped = applyUsageProjectAliases(
      {
        project: '3085e88f',
        cwd: '/Users/x/Library/Application Support/enso-code/worktrees/proj-uuid/3085e88f',
        records: [{ project: '3085e88f' }, { project: '3085e88f' }],
      },
      aliases
    );
    expect(remapped.project).toBe('enso-code');
    expect(remapped.records.every((record) => record.project === 'enso-code')).toBe(true);
  });
});
