import { describe, expect, it } from 'vitest';
import { applyHashlineToText } from './apply';

describe('applyHashlineToText', () => {
  it('替换首行时保留后续行和文件末尾换行', () => {
    expect(applyHashlineToText('world\nlater\n', 'PUT 1.=1:\n+hello')).toBe('hello\nlater\n');
  });

  it('同一补丁的多个 PUT 均按原始快照行号定位', () => {
    const patch = 'PUT 1.=1:\n+A1\n+A2\nPUT 4.=4:\n+D2';
    expect(applyHashlineToText('A\nB\nC\nD\n', patch)).toBe('A1\nA2\nB\nC\nD2\n');
  });

  it('拒绝把前一段编辑后的行号当成后一段 PUT 的锚点', () => {
    const patch = 'PUT 1.=2:\n+merged\n+draft\nPUT 2.=2:\n+final';
    expect(() => applyHashlineToText('one\ntwo\nthree\n', patch)).toThrow();
  });

  it('拒绝没有替换正文的 PUT', () => {
    expect(() => applyHashlineToText('one\ntwo\n', 'PUT 1.=1:')).toThrow();
  });

  it('拒绝替换后内容完全相同的无效补丁', () => {
    expect(() => applyHashlineToText('one\ntwo\n', 'PUT 1.=1:\n+one')).toThrow();
  });
});
