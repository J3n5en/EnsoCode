import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fuzzyScore, listFiles, searchFiles } from './fileSearch';

describe('fuzzyScore', () => {
  it('子序列按序命中才得分，乱序为 0', () => {
    expect(fuzzyScore('abc', 'a1b2c3')).toBeGreaterThan(0);
    expect(fuzzyScore('cba', 'a1b2c3')).toBe(0);
  });

  it('连续命中比离散命中分高', () => {
    expect(fuzzyScore('chat', 'ChatView.tsx')).toBeGreaterThan(fuzzyScore('chat', 'c-h-a-t.txt'));
  });

  it('空查询恒为 1', () => {
    expect(fuzzyScore('', 'anything')).toBe(1);
  });
});

describe('listFiles / searchFiles', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-fsearch-'));
    fs.mkdirSync(path.join(tmp, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'components', 'ChatView.tsx'), '');
    fs.writeFileSync(path.join(tmp, 'src', 'index.ts'), '');
    fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'index.js'), '');
    fs.writeFileSync(path.join(tmp, '.git', 'HEAD'), '');
    fs.writeFileSync(path.join(tmp, 'README.md'), '');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('忽略 node_modules 与 .git', () => {
    const files = listFiles(tmp);
    expect(files).toContain(path.join('src', 'index.ts'));
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.includes('.git'))).toBe(false);
  });

  it('模糊搜索按文件名优先命中', () => {
    const results = searchFiles(tmp, 'chatview');
    expect(results[0]?.relativePath).toBe(path.join('src', 'components', 'ChatView.tsx'));
  });

  it('空查询返回浅层文件在前', () => {
    const results = searchFiles(tmp, '');
    expect(results[0]?.relativePath).toBe('README.md');
  });

  it('目录不存在时不崩，返回空', () => {
    expect(searchFiles(path.join(tmp, 'nope'), 'x')).toEqual([]);
  });
});
