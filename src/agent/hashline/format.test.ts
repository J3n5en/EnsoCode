import { describe, expect, it } from 'vitest';
import { computeFileHash, formatHashlineHeader } from './format';

describe('computeFileHash', () => {
  it('生成稳定的 4 位大写十六进制标签', () => {
    const first = computeFileHash('alpha\nbeta\n');
    expect(first).toMatch(/^[0-9A-F]{4}$/);
    expect(computeFileHash('alpha\nbeta\n')).toBe(first);
  });

  it('忽略每一行及末行尾部的空格、制表符和回车', () => {
    expect(computeFileHash('alpha \t\r\nbeta\t\r')).toBe(computeFileHash('alpha\nbeta'));
  });

  it('文件内容变化时生成不同标签', () => {
    expect(computeFileHash('alpha\nbeta')).not.toBe(computeFileHash('alpha\ngamma'));
  });
});

describe('formatHashlineHeader', () => {
  it('把文件路径与标签格式化为 Hashline 文件头', () => {
    expect(formatHashlineHeader('src/example.ts', '1A2B')).toBe('[src/example.ts#1A2B]');
  });
});
