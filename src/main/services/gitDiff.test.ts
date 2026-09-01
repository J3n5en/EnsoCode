import { describe, expect, it } from 'vitest';
import { diffHead, type GitDiffHost } from './gitDiff';

function host(opts: {
  inside?: boolean;
  nameStatus?: string;
  others?: string;
  show?: Record<string, string | null>;
  files?: Record<string, string | null>;
}): GitDiffHost {
  return {
    isDir: () => true,
    async run(args) {
      const key = args.join(' ');
      if (key.startsWith('rev-parse --is-inside-work-tree')) {
        return opts.inside === false
          ? { code: 128, stdout: '', stderr: 'not a git repo' }
          : { code: 0, stdout: 'true\n', stderr: '' };
      }
      if (key.startsWith('diff HEAD --name-status')) {
        return { code: 0, stdout: opts.nameStatus ?? '', stderr: '' };
      }
      if (key.startsWith('ls-files --others')) {
        return { code: 0, stdout: opts.others ?? '', stderr: '' };
      }
      if (args[0] === 'show' && args[1]?.startsWith('HEAD:')) {
        const path = args[1].slice('HEAD:'.length);
        const text = opts.show?.[path];
        return text == null
          ? { code: 128, stdout: '', stderr: 'missing' }
          : { code: 0, stdout: text, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
    async readFile(absPath) {
      const rel = absPath.replace(/^\/repo\//, '');
      return opts.files?.[rel] ?? null;
    },
  };
}

describe('diffHead', () => {
  it('非仓库返回 not-repo', async () => {
    const result = await diffHead('/repo', host({ inside: false }));
    expect(result).toEqual({ ok: false, error: 'not-repo' });
  });

  it('含已暂存 modified 与 untracked', async () => {
    const result = await diffHead(
      '/repo',
      host({
        nameStatus: 'M\0src/a.ts\0',
        others: 'new.ts\0',
        show: { 'src/a.ts': 'old a' },
        files: { 'src/a.ts': 'new a', 'new.ts': 'fresh' },
      })
    );
    expect(result).toEqual({
      ok: true,
      files: [
        { path: 'src/a.ts', status: 'modified', oldText: 'old a', newText: 'new a' },
        { path: 'new.ts', status: 'untracked', oldText: '', newText: 'fresh' },
      ],
    });
  });

  it('deleted 只有 old', async () => {
    const result = await diffHead(
      '/repo',
      host({
        nameStatus: 'D\0gone.ts\0',
        show: { 'gone.ts': 'bye' },
        files: {},
      })
    );
    expect(result).toEqual({
      ok: true,
      files: [{ path: 'gone.ts', status: 'deleted', oldText: 'bye', newText: '' }],
    });
  });

  it('读不到内容（过大/二进制）则跳过', async () => {
    const result = await diffHead(
      '/repo',
      host({
        nameStatus: 'M\0bin.dat\0',
        show: { 'bin.dat': 'xxx' },
        files: { 'bin.dat': null },
      })
    );
    expect(result).toEqual({ ok: true, files: [] });
  });
});
