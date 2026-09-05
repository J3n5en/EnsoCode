import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertEntryName,
  createLocalDir,
  createLocalFile,
  joinUnderCwd,
  RefCountWatchers,
  readLocalImage,
  removeLocal,
  renameLocal,
  resolveUnderCwd,
} from './filesWorkspace';

describe('resolveUnderCwd', () => {
  const cwd = path.resolve('/repo');

  it('空 rel 落在 cwd', () => {
    expect(resolveUnderCwd(cwd, '')).toBe(cwd);
    expect(resolveUnderCwd(cwd, '.')).toBe(cwd);
  });

  it('相对路径 join', () => {
    expect(resolveUnderCwd(cwd, 'src/a.ts')).toBe(path.resolve('/repo/src/a.ts'));
  });

  it('拒绝 .. 逃出', () => {
    expect(resolveUnderCwd(cwd, '../secret')).toBeNull();
    expect(resolveUnderCwd(cwd, 'src/../../etc/passwd')).toBeNull();
  });

  it('拒绝绝对路径逃出', () => {
    expect(resolveUnderCwd(cwd, '/etc/passwd')).toBeNull();
  });
});

describe('assertEntryName', () => {
  it('接受单层文件名', () => {
    expect(assertEntryName('INSTALL.md')).toBe(true);
    expect(assertEntryName('src')).toBe(true);
  });

  it('拒绝空名、点名和路径分隔', () => {
    expect(assertEntryName('')).toBe(false);
    expect(assertEntryName('.')).toBe(false);
    expect(assertEntryName('..')).toBe(false);
    expect(assertEntryName('a/b')).toBe(false);
    expect(assertEntryName('a\\b')).toBe(false);
    expect(assertEntryName('a\0b')).toBe(false);
  });
});

describe('local mutate', () => {
  let tmp = '';
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  });

  it('创建空文件与目录，冲突不覆盖', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'enso-files-'));
    const file = joinUnderCwd(tmp, '', 'a.txt');
    const dir = joinUnderCwd(tmp, '', 'docs');
    expect(file && createLocalFile(file)).toBeNull();
    expect(file && readFileSync(file, 'utf8')).toBe('');
    expect(file && createLocalFile(file)).toBe('exists');
    expect(dir && createLocalDir(dir)).toBeNull();
    expect(dir && createLocalDir(dir)).toBe('exists');
  });

  it('重命名成功，目标已存在则失败', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'enso-files-'));
    const from = joinUnderCwd(tmp, '', 'old.txt');
    const to = joinUnderCwd(tmp, '', 'new.txt');
    const other = joinUnderCwd(tmp, '', 'taken.txt');
    if (!from || !to || !other) throw new Error('join');
    writeFileSync(from, 'x');
    writeFileSync(other, 'y');
    expect(renameLocal(from, to)).toBeNull();
    expect(existsSync(to)).toBe(true);
    expect(renameLocal(to, other)).toBe('exists');
  });

  it('重命名不能覆盖悬空软链接', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'enso-files-'));
    const from = path.join(tmp, 'source');
    const to = path.join(tmp, 'link');
    writeFileSync(from, 'keep');
    symlinkSync(path.join(tmp, 'missing'), to);
    expect(renameLocal(from, to)).toBe('exists');
  });

  it('删除文件，拒绝删 cwd 根', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'enso-files-'));
    const file = joinUnderCwd(tmp, '', 'gone.txt');
    if (!file) throw new Error('join');
    writeFileSync(file, 'x');
    expect(removeLocal(tmp, tmp)).toBe('invalid-path');
    expect(removeLocal(file, tmp)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });
});

describe('readLocalImage', () => {
  let tmp = '';
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  });

  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('读取图片字节并按 mime 编码为 data URL', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'enso-files-'));
    const abs = path.join(tmp, 'a.png');
    writeFileSync(abs, PNG_MAGIC);
    const result = readLocalImage(abs, 'image/png');
    expect(result).toEqual({
      ok: true,
      dataUrl: `data:image/png;base64,${PNG_MAGIC.toString('base64')}`,
    });
  });

  it('内容魔数与声明的 mime 不符时拒绝（防把 SVG/HTML 改后缀伪装成位图）', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'enso-files-'));
    const abs = path.join(tmp, 'fake.png');
    writeFileSync(abs, '<svg onload="alert(1)"></svg>');
    expect(readLocalImage(abs, 'image/png')).toEqual({ ok: false, error: 'unsupported' });
  });

  it('svg 声明与内容匹配时放行（只通过 <img> 标签渲染，浏览器按图片上下文禁脚本）', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'enso-files-'));
    const abs = path.join(tmp, 'a.svg');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    writeFileSync(abs, svg);
    expect(readLocalImage(abs, 'image/svg+xml')).toEqual({
      ok: true,
      dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    });
  });

  it('超过大小上限拒绝', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'enso-files-'));
    const abs = path.join(tmp, 'a.png');
    writeFileSync(abs, Buffer.alloc(10));
    expect(readLocalImage(abs, 'image/png', 5)).toEqual({ ok: false, error: 'too-large' });
  });

  it('目标不是文件或不存在时失败', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'enso-files-'));
    expect(readLocalImage(path.join(tmp, 'missing.png'), 'image/png')).toEqual({
      ok: false,
      error: 'unavailable',
    });
    expect(readLocalImage(tmp, 'image/png')).toEqual({ ok: false, error: 'unavailable' });
  });
});

describe('RefCountWatchers', () => {
  it('同 key 第二次 acquire 不重复 start，release 到 0 才 stop', () => {
    let starts = 0;
    let stops = 0;
    const table = new RefCountWatchers();
    const start = () => {
      starts += 1;
      return () => {
        stops += 1;
      };
    };
    table.acquire('a', start);
    table.acquire('a', start);
    expect(starts).toBe(1);
    expect(table.size).toBe(1);
    table.release('a');
    expect(stops).toBe(0);
    table.release('a');
    expect(stops).toBe(1);
    expect(table.size).toBe(0);
  });

  it('releaseAll 按前缀清掉剩余 watch', () => {
    let stops = 0;
    const table = new RefCountWatchers();
    const start = () => () => {
      stops += 1;
    };
    table.acquire('c1:foo.ts', start);
    table.acquire('c1:bar.ts', start);
    table.acquire('c2:z.ts', start);
    table.releaseAll((key) => key.startsWith('c1:'));
    expect(stops).toBe(2);
    expect(table.size).toBe(1);
  });
});
