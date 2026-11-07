import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReadmeRequest, README_MAX_BYTES, readPackageReadme } from './readme';

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-readme-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseReadmeRequest', () => {
  it('只收插件 id 和来源，不收路径', () => {
    expect(parseReadmeRequest({ id: 'example.demo', from: 'installed' })).toEqual({
      id: 'example.demo',
      from: 'installed',
    });
    expect(parseReadmeRequest({ id: 'example.demo', from: 'market', path: '../x' })).toEqual({
      id: 'example.demo',
      from: 'market',
    });
    expect(parseReadmeRequest({ id: '../x', from: 'installed' })).toBeNull();
    expect(parseReadmeRequest({ id: 'example.demo', from: 'disk' })).toBeNull();
    expect(parseReadmeRequest(null)).toBeNull();
  });
});

describe('readPackageReadme', () => {
  it('读取安装目录里的 README', () => {
    const dir = temp();
    writeFileSync(join(dir, 'README.md'), '# Hi\n');
    expect(readPackageReadme(dir)).toEqual({ ok: true, markdown: '# Hi\n' });
  });

  it('没有文件时失败', () => {
    expect(readPackageReadme(temp()).ok).toBe(false);
  });

  it('超过 256KB 不读取', () => {
    const dir = temp();
    writeFileSync(join(dir, 'README.md'), 'x'.repeat(README_MAX_BYTES + 1));
    expect(readPackageReadme(dir)).toEqual({ ok: false, error: '使用说明过大' });
  });

  it('符号链接指向目录外时拒绝', () => {
    const dir = temp();
    const outside = temp();
    writeFileSync(join(outside, 'secret.md'), 'secret');
    symlinkSync(join(outside, 'secret.md'), join(dir, 'README.md'));
    expect(readPackageReadme(dir)).toEqual({ ok: false, error: '没有使用说明' });
  });
});
