import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWorkspaceBranches, switchWorkspaceBranch, workspaceIdentityPath } from './gitBranches';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
let templateRoot: string;
let root: string;
let repo: string;
beforeAll(() => {
  templateRoot = mkdtempSync(join(tmpdir(), 'enso-branches-tpl-'));
  const templateRepo = join(templateRoot, 'repo');
  git(templateRoot, 'init', '-q', '-b', 'main', templateRepo);
  git(templateRepo, 'config', 'user.name', 'test');
  git(templateRepo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(templateRepo, 'file.txt'), 'main\n');
  git(templateRepo, 'add', '.');
  git(templateRepo, 'commit', '-qm', 'initial');
  git(templateRepo, 'branch', 'feature');
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'enso-branches-'));
  rmSync(root, { recursive: true, force: true });
  cpSync(templateRoot, root, { recursive: true });
  repo = join(root, 'repo');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
afterAll(() => rmSync(templateRoot, { recursive: true, force: true }));

describe('workspace branches', () => {
  it('resolves the default branch from cached origin HEAD without changing the checkout', async () => {
    git(repo, 'branch', 'release/stable');
    git(repo, 'update-ref', 'refs/remotes/origin/release/stable', 'HEAD');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release/stable');
    git(repo, 'config', 'init.defaultBranch', 'main');
    const snapshot = await readWorkspaceBranches(repo);
    expect(snapshot.defaultBranch).toBe('release/stable');
    expect(snapshot.currentBranch).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('uses an existing configured default branch when origin HEAD is unavailable', async () => {
    git(repo, 'branch', 'trunk');
    git(repo, 'config', 'init.defaultBranch', 'trunk');
    expect((await readWorkspaceBranches(repo)).defaultBranch).toBe('trunk');
  });

  it('falls back to existing main or master rather than an absent configured branch', async () => {
    git(repo, 'config', 'init.defaultBranch', 'missing');
    expect((await readWorkspaceBranches(repo)).defaultBranch).toBe('main');
    git(repo, 'branch', '-m', 'main', 'master');
    expect((await readWorkspaceBranches(repo)).defaultBranch).toBe('master');
  });

  it('does not guess that an arbitrary current branch is the default', async () => {
    git(repo, 'config', 'init.defaultBranch', 'missing');
    git(repo, 'branch', '-m', 'main', 'topic');
    const snapshot = await readWorkspaceBranches(repo);
    expect(snapshot.currentBranch).toBe('topic');
    expect(snapshot.defaultBranch).toBeNull();
  });

  it('keeps the same default branch when reading a linked worktree', async () => {
    git(repo, 'config', 'init.defaultBranch', 'main');
    const other = join(root, 'linked');
    git(repo, 'worktree', 'add', other, 'feature');
    const snapshot = await readWorkspaceBranches(other);
    expect(snapshot.currentBranch).toBe('feature');
    expect(snapshot.defaultBranch).toBe('main');
  });
  it('uses the Git worktree root as physical identity for project subdirectories', () => {
    const nested = join(repo, 'nested');
    mkdirSync(nested);
    expect(workspaceIdentityPath(nested)).toBe(realpathSync(repo));
    expect(workspaceIdentityPath(repo)).toBe(realpathSync(repo));
    expect(workspaceIdentityPath(join(root, 'missing'))).toBe(join(root, 'missing'));
  });
  it('reads local branches and switches the current physical workspace', async () => {
    git(repo, 'switch', 'feature');
    writeFileSync(join(repo, 'file.txt'), 'feature\n');
    git(repo, 'commit', '-am', 'feature');
    git(repo, 'switch', 'main');
    const before = await readWorkspaceBranches(repo);
    expect(before.currentBranch).toBe('main');
    expect(before.branches.map((branch) => branch.name)).toEqual(['feature', 'main']);
    await switchWorkspaceBranch(repo, 'feature', false);
    expect(git(repo, 'branch', '--show-current')).toBe('feature');
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('feature\n');
  });

  it('rechecks Main authority immediately before invoking a mutating Git command', async () => {
    await expect(
      switchWorkspaceBranch(repo, 'new/branch', true, () => {
        throw new Error('authority changed');
      })
    ).rejects.toThrow('authority changed');
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    expect(git(repo, 'branch', '--list', 'new/branch')).toBe('');
  });

  it('reports physical mutation before any post-switch projection failure', async () => {
    let applied: string | null = null;
    await expect(
      switchWorkspaceBranch(repo, 'feature', false, undefined, (snapshot) => {
        applied = snapshot.currentBranch;
        throw new Error('projection failed');
      })
    ).rejects.toThrow('projection failed');
    expect(applied).toBe('feature');
    expect(git(repo, 'branch', '--show-current')).toBe('feature');
  });

  it('creates from the current HEAD, including detached HEAD', async () => {
    git(repo, 'checkout', '--detach');
    const head = git(repo, 'rev-parse', 'HEAD');
    expect((await readWorkspaceBranches(repo)).currentBranch).toBeNull();
    await switchWorkspaceBranch(repo, 'new/topic', true);
    expect(git(repo, 'branch', '--show-current')).toBe('new/topic');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  it.each(['untracked', 'unstaged', 'staged'])(
    'rejects %s changes without creating a branch',
    async (kind) => {
      const file = join(repo, kind === 'untracked' ? 'new.txt' : 'file.txt');
      writeFileSync(file, 'keep me\n');
      if (kind === 'staged') git(repo, 'add', '.');
      await expect(switchWorkspaceBranch(repo, 'new/topic', true)).rejects.toMatchObject({
        code: 'dirty',
      });
      expect(git(repo, 'branch', '--show-current')).toBe('main');
      expect(git(repo, 'branch', '--list', 'new/topic')).toBe('');
      expect(readFileSync(file, 'utf8')).toBe('keep me\n');
    }
  );

  it.each(['-f', '--detach', '@{-1}', 'bad..branch', 'bad name', 'HEAD', 'x\nname', ''])(
    'rejects unsafe branch %j without mutation',
    async (branch) => {
      await expect(switchWorkspaceBranch(repo, branch, true)).rejects.toMatchObject({
        code: 'invalid-branch',
      });
      expect(git(repo, 'branch', '--show-current')).toBe('main');
      expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe(
        'refs/heads/feature\nrefs/heads/main'
      );
    }
  );

  it('reports other worktree occupancy with spaces and refuses both occupied and current branches', async () => {
    const other = join(root, 'other workspace');
    git(repo, 'worktree', 'add', other, 'feature');
    const snapshot = await readWorkspaceBranches(repo);
    expect(snapshot.branches.find((branch) => branch.name === 'feature')?.worktreePath).toBe(
      realpathSync(other)
    );
    await expect(switchWorkspaceBranch(repo, 'feature', false)).rejects.toMatchObject({
      code: 'occupied',
    });
    await expect(switchWorkspaceBranch(repo, 'main', false)).rejects.toMatchObject({
      code: 'same-branch',
    });
    expect(git(repo, 'branch', '--show-current')).toBe('main');
  });

  it.each([
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
  ])('refuses clean in-progress Git state %s', async (marker) => {
    writeFileSync(join(repo, '.git', marker), 'in progress');
    await expect(switchWorkspaceBranch(repo, 'feature', false)).rejects.toMatchObject({
      code: 'busy',
    });
    expect(git(repo, 'branch', '--show-current')).toBe('main');
  });

  it('passes valid shell metacharacters as literal branch arguments', async () => {
    const branch = 'topic;echo$HOME';
    await switchWorkspaceBranch(repo, branch, true);
    expect(git(repo, 'branch', '--show-current')).toBe(branch);
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('main\n');
  });

  it('does not guess remote branches or replace existing local branches', async () => {
    await expect(switchWorkspaceBranch(repo, 'missing', false)).rejects.toMatchObject({
      code: 'branch-not-found',
    });
    await expect(switchWorkspaceBranch(repo, 'feature', true)).rejects.toMatchObject({
      code: 'branch-exists',
    });
    expect(git(repo, 'branch', '--show-current')).toBe('main');
  });

  it('reports unborn HEAD and rejects creation without an initial commit', async () => {
    const empty = join(root, 'empty');
    git(root, 'init', '-q', '-b', 'main', empty);
    expect(await readWorkspaceBranches(empty)).toMatchObject({
      currentBranch: 'main',
      headCommit: null,
      branches: [],
    });
    await expect(switchWorkspaceBranch(empty, 'new', true)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(git(empty, 'branch', '--show-current')).toBe('main');
  });
});
