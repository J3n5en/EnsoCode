import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionWorktree } from '../../../shared/types/worktree';
import { WorktreeRegistry } from './registry';

let dir: string;
let file: string;

const record = (id: string): SessionWorktree => ({
  conversationId: id,
  projectId: 'p1',
  repoPath: '/repo',
  path: `/worktrees/p1/${id}`,
  branch: `enso/${id}`,
  baseBranch: 'main',
  baseCommit: 'abc123',
  createdAt: 1000,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'enso-wt-reg-'));
  file = join(dir, 'worktrees.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('WorktreeRegistry', () => {
  it('set/get/delete 并持久化到磁盘', () => {
    const reg = new WorktreeRegistry(file);
    expect(reg.get('c1')).toBeUndefined();
    reg.set(record('c1'));
    expect(reg.get('c1')?.branch).toBe('enso/c1');

    // 重新加载还在
    const reloaded = new WorktreeRegistry(file);
    expect(reloaded.get('c1')?.path).toBe('/worktrees/p1/c1');

    reg.delete('c1');
    expect(reg.get('c1')).toBeUndefined();
    expect(new WorktreeRegistry(file).get('c1')).toBeUndefined();
  });

  it('list 按 projectId 过滤', () => {
    const reg = new WorktreeRegistry(file);
    reg.set(record('c1'));
    reg.set({ ...record('c2'), projectId: 'p2' });
    expect(reg.list().length).toBe(2);
    expect(reg.list('p1').map((r) => r.conversationId)).toEqual(['c1']);
  });

  it('损坏的 JSON 文件不崩溃，当空库处理', () => {
    writeFileSync(file, 'not json{{{');
    const reg = new WorktreeRegistry(file);
    expect(reg.list()).toEqual([]);
    reg.set(record('c1'));
    expect(JSON.parse(readFileSync(file, 'utf8')).c1.branch).toBe('enso/c1');
  });
});
