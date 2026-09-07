import { describe, expect, it } from 'vitest';
import { computeFileHash, formatHashlineHeader } from './format';
import { applyHashlineInput } from './patch';

describe('applyHashlineInput', () => {
  it('解析带文件头的补丁并保留末尾换行', () => {
    const original = 'world\nlater\n';
    const header = formatHashlineHeader('/tmp/a.ts', computeFileHash(original));
    expect(applyHashlineInput(original, `${header}\nPUT 1.=1:\n+hello`)).toBe('hello\nlater\n');
  });

  it('文件头标签与当前内容不符时拒绝补丁', () => {
    const original = 'world\n';
    const liveTag = computeFileHash(original);
    const staleTag = liveTag === '0000' ? '0001' : '0000';
    expect(() =>
      applyHashlineInput(original, `[/tmp/a.ts#${staleTag}]\nPUT 1.=1:\n+hello`)
    ).toThrow();
  });

  it('文件头省略时仍可应用 PUT 正文', () => {
    expect(applyHashlineInput('world\n', 'PUT 1.=1:\n+hello')).toBe('hello\n');
  });

  it('拒绝未知关键字或无效补丁文本', () => {
    expect(() => applyHashlineInput('world\n', 'BOGUS 1.=1:\n+hello')).toThrow();
  });

  it('没有 BlockResolver 时拒绝 N* 块锚点', () => {
    expect(() => applyHashlineInput('fn() {\n  x\n}\n', 'PUT 1*:\n+replaced')).toThrow();
  });
});
