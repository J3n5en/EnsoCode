import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchHostDirs } from './hostDirSearch';

const SKIP = [
  'node_modules',
  'venv',
  'env',
  'dist',
  'build',
  'target',
  'out',
  'coverage',
  'vendor',
  '__pycache__',
];

describe('searchHostDirs', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'host-dir-search-'));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('returns the machine name and no results for a blank query', async () => {
    mkdirSync(path.join(home, 'zq'));
    expect(await searchHostDirs('  \n', path.join(home, 'missing'))).toEqual({
      ok: true,
      host: hostname(),
      results: [],
    });
  });

  it('matches case-insensitively and orders exact, prefix, contains, then shallower and alpha', async () => {
    for (const rel of ['zq', 'nested/zq', 'zq-a', 'zq-b', 'ZqMix', 'a-zq', 'b-zq', 'deep/x/myzq']) {
      mkdirSync(path.join(home, rel), { recursive: true });
    }
    writeFileSync(path.join(home, 'zq-file'), '');
    const result = await searchHostDirs('ZQ', home);
    expect(result).toEqual({
      ok: true,
      host: hostname(),
      results: ['zq', 'nested/zq', 'zq-a', 'zq-b', 'ZqMix', 'a-zq', 'b-zq', 'deep/x/myzq'].map(
        (rel) => ({
          path: path.join(home, rel),
          displayPath: `~/${rel}`,
        })
      ),
    });
  });

  it('matches a query that spans path segments below any single-segment hit', async () => {
    mkdirSync(path.join(home, 'nest', 'zq'), { recursive: true });
    mkdirSync(path.join(home, 'nest', 'zq-more'), { recursive: true });
    mkdirSync(path.join(home, 'aa', 'nest', 'zq'), { recursive: true });
    mkdirSync(path.join(home, 'zq'));
    const result = await searchHostDirs('nest/zq', home);
    expect(result).toMatchObject({ ok: true, host: hostname() });
    if (!result.ok) return;
    expect(result.results.map((item) => item.displayPath)).toEqual([
      '~/nest/zq',
      '~/nest/zq-more',
      '~/aa/nest/zq',
    ]);
  });

  it('skips hidden and heavy directories and does not descend past depth 6', async () => {
    for (const name of SKIP) mkdirSync(path.join(home, name, 'zq-secret'), { recursive: true });
    mkdirSync(path.join(home, '.hidden', 'zq-secret'), { recursive: true });
    mkdirSync(path.join(home, 'a', 'b', 'c', 'd', 'e', 'zqdeep'), { recursive: true });
    mkdirSync(path.join(home, 'a', 'b', 'c', 'd', 'e', 'f', 'zqtoo'), { recursive: true });
    const result = await searchHostDirs('zq', home);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.results.map((item) => item.displayPath)).toEqual(['~/a/b/c/d/e/zqdeep']);
  });

  it('does not read ~/Library on macOS', async () => {
    mkdirSync(path.join(home, 'Library', 'SecretProj'), { recursive: true });
    mkdirSync(path.join(home, 'Work', 'SecretProj'), { recursive: true });
    const result = await searchHostDirs('SecretProj', home);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const found = result.results.map((item) => item.path);
    expect(found).toContain(path.join(home, 'Work', 'SecretProj'));
    if (process.platform === 'darwin') {
      expect(found).not.toContain(path.join(home, 'Library', 'SecretProj'));
    }
  });

  it('returns at most 20 matches, shallow and alphabetical first', async () => {
    for (let i = 0; i < 25; i++) mkdirSync(path.join(home, `hit-${String(i).padStart(2, '0')}`));
    mkdirSync(path.join(home, 'nested', 'hit-00'), { recursive: true });
    const result = await searchHostDirs('hit-', home);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.results.map((item) => item.displayPath)).toEqual(
      Array.from({ length: 20 }, (_, i) => `~/hit-${String(i).padStart(2, '0')}`)
    );
  });

  it('stops after 4000 scanned entries and still returns earlier matches', async () => {
    for (let i = 0; i < 4000; i++) mkdirSync(path.join(home, `n${String(i).padStart(4, '0')}`));
    mkdirSync(path.join(home, 'zzzz-late'));
    const early = await searchHostDirs('n0000', home);
    const late = await searchHostDirs('zzzz-late', home);
    expect(early).toMatchObject({
      ok: true,
      results: [{ path: path.join(home, 'n0000'), displayPath: '~/n0000' }],
    });
    expect(late).toMatchObject({ ok: true, results: [] });
  });

  it('skips an unreadable directory without failing the rest', async () => {
    const blocked = path.join(home, 'blocked');
    mkdirSync(blocked);
    mkdirSync(path.join(home, 'ok-match'));
    await chmod(blocked, 0);
    try {
      const result = await searchHostDirs('match', home);
      expect(result).toMatchObject({
        ok: true,
        results: [{ path: path.join(home, 'ok-match'), displayPath: '~/ok-match' }],
      });
    } finally {
      await chmod(blocked, 0o755);
    }
  });

  it('reports an error when the home directory itself cannot be read', async () => {
    const missing = path.join(home, 'missing');
    expect(await searchHostDirs('zq', missing)).toMatchObject({ ok: false });
  });

  it('does not match segments of the home directory itself', async () => {
    const polluted = path.join(home, 'zqhome');
    mkdirSync(path.join(polluted, 'deep', 'x', 'mydir'), { recursive: true });
    mkdirSync(path.join(polluted, 'nested'));
    const result = await searchHostDirs('zq', polluted);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.results.map((item) => item.displayPath)).toEqual([]);
  });
});
