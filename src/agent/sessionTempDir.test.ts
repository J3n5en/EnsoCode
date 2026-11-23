import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimSessionTempRoot,
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

  it('会话目录在 Temp 下带唯一前缀的根目录里，不同会话不同目录', () => {
    const a = sessionTempDir(ID, opts);
    const b = sessionTempDir('22222222-2222-4222-8222-222222222222', opts);
    const root = sessionTempRoot(tmp);
    expect(path.dirname(root)).toBe(tmp);
    expect(path.basename(root)).toMatch(/^enso-session-temp(-\d+)?$/);
    expect(a).toBe(path.join(root, ID));
    expect(b).not.toBe(a);
  });

  it('子会话嵌在父会话目录下，删父会话一并带走', () => {
    const child = sessionTempDir(`${ID}::cw-abc`, opts);
    expect(child).toBe(path.join(sessionTempRoot(tmp), ID, 'cw-abc'));
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

  it('Temp 落在项目目录、等于用户目录、是文件系统根或不是绝对路径时不给路径', () => {
    expect(sessionTempDir(ID, { ...opts, tmp: opts.cwd })).toBeNull();
    expect(sessionTempDir(ID, { ...opts, tmp: path.join(opts.cwd, 'tmp') })).toBeNull();
    expect(sessionTempDir(ID, { ...opts, tmp: opts.home })).toBeNull();
    expect(sessionTempDir(ID, { ...opts, tmp: 'relative/tmp' })).toBeNull();
    expect(sessionTempDir(ID, { ...opts, tmp: '' })).toBeNull();
    expect(sessionTempDir(ID, { ...opts, tmp: path.parse(tmp).root })).toBeNull();
  });
});

describe('sessionTempDir 清理', () => {
  let tmp: string;
  let root: string;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'enso-tempdir-'));
    root = sessionTempRoot(tmp);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  const age = (target: string, ms: number) => {
    const t = (Date.now() - ms) / 1000;
    utimesSync(target, t, t);
  };
  const dirOf = (id: string) => sessionTempDir(id, { tmp, cwd: '/w' }) as string;
  /** Temp 外的一个目录，里面放着同名的会话目录与文件：任何逃逸都会删掉它们 */
  const outsideWith = (name: string) => {
    const outside = mkdtempSync(path.join(tmpdir(), 'enso-tempdir-outside-'));
    mkdirSync(path.join(outside, name), { recursive: true });
    writeFileSync(path.join(outside, name, 'precious.txt'), 'x');
    return outside;
  };

  it('ensure 建出目录；remove 只删自己的会话目录，不碰 Temp 根和别的会话', () => {
    const dir = dirOf(ID);
    const other = dirOf('other');
    ensureSessionTempDir(dir, root);
    ensureSessionTempDir(other, root);
    mkdirSync(path.join(dir, 'cw-a'));
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

  it('没有归属标记的同名根目录（不是 EnsoCode 建的）拒绝删除并记日志', async () => {
    mkdirSync(path.join(root, ID), { recursive: true });
    writeFileSync(path.join(root, ID, 'foreign.txt'), 'x');
    age(path.join(root, ID), SESSION_TEMP_RETENTION_MS + 60_000);

    removeSessionTempDir(ID, tmp);
    await pruneSessionTempDirs(root);
    expect(existsSync(path.join(root, ID, 'foreign.txt'))).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('根目录是指向别处的符号链接 / junction 时拒绝删除，链接目标原样保留', async () => {
    const outside = outsideWith(ID);
    try {
      claimSessionTempRoot(sessionTempRoot(outside));
      age(path.join(outside, ID), SESSION_TEMP_RETENTION_MS + 60_000);
      symlinkSync(sessionTempRoot(outside), root, 'junction');
      mkdirSync(path.join(sessionTempRoot(outside), ID), { recursive: true });
      writeFileSync(path.join(sessionTempRoot(outside), ID, 'precious.txt'), 'x');

      removeSessionTempDir(ID, tmp);
      await pruneSessionTempDirs(root, { maxAgeMs: 0, now: Date.now() + 60_000 });
      expect(existsSync(path.join(sessionTempRoot(outside), ID, 'precious.txt'))).toBe(true);
      expect(existsSync(path.join(outside, ID, 'precious.txt'))).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('会话目录是指向别处的符号链接时拒绝删除，链接目标原样保留', async () => {
    const outside = outsideWith('data');
    try {
      claimSessionTempRoot(root);
      symlinkSync(path.join(outside, 'data'), path.join(root, ID), 'junction');
      symlinkSync(path.join(outside, 'data'), path.join(root, 'old'), 'junction');

      removeSessionTempDir(ID, tmp);
      await pruneSessionTempDirs(root, { maxAgeMs: 0, now: Date.now() + 60_000 });
      expect(existsSync(path.join(outside, 'data', 'precious.txt'))).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('空路径、相对路径、文件系统根作为 Temp 时什么都不删', () => {
    ensureSessionTempDir(dirOf(ID), root);
    // 相对路径按进程 cwd 解析后正好指向这个 Temp：仍然不能删
    for (const bad of ['', path.relative(process.cwd(), tmp), path.parse(tmp).root]) {
      removeSessionTempDir(ID, bad);
    }
    expect(existsSync(dirOf(ID))).toBe(true);
  });

  it('过期清理只删 enso 根下超期的会话目录，Temp 根里的文件不动', async () => {
    claimSessionTempRoot(root);
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
