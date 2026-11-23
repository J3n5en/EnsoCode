import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureSessionTempDir,
  pruneSessionTempDirs,
  removeSessionTempDir,
  SESSION_TEMP_RETENTION_MS,
  sessionTempDir,
  sessionTempRoot,
} from './sessionTempDir';

const ID = '11111111-1111-4111-8111-111111111111';

describe('sessionTempDir 路径推导', () => {
  const tmp = path.resolve('/fake/Temp');
  const opts = { tmp, cwd: path.resolve('/work/project'), home: path.resolve('/home/u') };

  it('会话目录在 <Temp>/enso/<会话> 下，不同会话不同目录', () => {
    const a = sessionTempDir(ID, opts);
    const b = sessionTempDir('22222222-2222-4222-8222-222222222222', opts);
    expect(a).toBe(path.join(tmp, 'enso', ID));
    expect(b).not.toBe(a);
    expect(sessionTempRoot(tmp)).toBe(path.join(tmp, 'enso'));
  });

  it('子会话嵌在父会话目录下，删父会话一并带走', () => {
    const child = sessionTempDir(`${ID}::cw-abc`, opts);
    expect(child).toBe(path.join(tmp, 'enso', ID, 'cw-abc'));
  });

  it('非法字符、路径穿越与超长 id 用定长哈希，结果仍在根目录内', () => {
    const root = sessionTempRoot(tmp);
    for (const bad of ['..', '../../etc', 'a/b', 'a\\b', 'C:', 'x y', '', 'z'.repeat(200)]) {
      const dir = sessionTempDir(bad, opts);
      expect(dir).not.toBeNull();
      const rel = path.relative(root, dir as string);
      expect(rel.startsWith('..') || path.isAbsolute(rel) || rel === '').toBe(false);
      expect(path.basename(dir as string)).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(sessionTempDir('a:b', opts)).not.toBe(sessionTempDir('a_b', opts));
  });

  it('Temp 落在项目目录或等于用户目录时不给路径', () => {
    expect(sessionTempDir(ID, { ...opts, tmp: opts.cwd })).toBeNull();
    expect(sessionTempDir(ID, { ...opts, tmp: path.join(opts.cwd, 'tmp') })).toBeNull();
    expect(sessionTempDir(ID, { ...opts, tmp: opts.home })).toBeNull();
    expect(sessionTempDir(ID, { ...opts, tmp: 'relative/tmp' })).toBeNull();
    expect(sessionTempDir(ID, { ...opts, tmp: '' })).toBeNull();
  });
});

describe('sessionTempDir 清理', () => {
  let tmp: string;
  let root: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'enso-tempdir-'));
    root = sessionTempRoot(tmp);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const age = (target: string, ms: number) => {
    const t = (Date.now() - ms) / 1000;
    utimesSync(target, t, t);
  };

  it('ensure 建出目录；remove 只删自己的会话目录，不碰 Temp 根和别的会话', () => {
    const dir = sessionTempDir(ID, { tmp, cwd: '/w' }) as string;
    const other = sessionTempDir('other', { tmp, cwd: '/w' }) as string;
    ensureSessionTempDir(dir, root);
    ensureSessionTempDir(other, root);
    writeFileSync(path.join(dir, 'a.ps1'), 'x');
    const outsider = path.join(tmp, 'someone-else.txt');
    writeFileSync(outsider, 'x');

    removeSessionTempDir(ID, tmp);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(outsider)).toBe(true);
    expect(existsSync(root)).toBe(true);

    removeSessionTempDir('..', tmp);
    removeSessionTempDir('', tmp);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(outsider)).toBe(true);
  });

  it('过期清理只删 enso 根下超期的会话目录，Temp 根里的文件不动', async () => {
    const stale = path.join(root, 'stale');
    const fresh = path.join(root, 'fresh');
    const keep = path.join(root, 'keep');
    for (const dir of [stale, fresh, keep]) mkdirSync(dir, { recursive: true });
    const outsider = path.join(tmp, 'old-foreign');
    mkdirSync(outsider);
    age(stale, SESSION_TEMP_RETENTION_MS + 60_000);
    age(keep, SESSION_TEMP_RETENTION_MS + 60_000);
    age(outsider, SESSION_TEMP_RETENTION_MS + 60_000);

    await pruneSessionTempDirs(root, { keep });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(outsider)).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  it('根目录不存在或不可读时清理不抛错', async () => {
    await expect(pruneSessionTempDirs(path.join(tmp, 'missing'))).resolves.toBeUndefined();
    expect(() => removeSessionTempDir(ID, path.join(tmp, 'missing'))).not.toThrow();
    writeFileSync(path.join(tmp, 'f'), 'not a dir');
    expect(() => ensureSessionTempDir(path.join(tmp, 'f', 'x'), path.join(tmp, 'f'))).not.toThrow();
  });
});
