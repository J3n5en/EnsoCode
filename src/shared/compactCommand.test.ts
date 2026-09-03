import { describe, expect, it } from 'vitest';
import { parseCompactCommand } from './compactCommand';

describe('parseCompactCommand', () => {
  it('裸命令返回空对象（不带自定义指令）', () => {
    expect(parseCompactCommand('/compact')).toEqual({});
    expect(parseCompactCommand('  /compact  ')).toEqual({});
  });

  it('带参数时把其余正文当作摘要指令', () => {
    expect(parseCompactCommand('/compact 只保留接口契约')).toEqual({
      instructions: '只保留接口契约',
    });
    expect(parseCompactCommand('/compact  多行\n第二行 ')).toEqual({
      instructions: '多行\n第二行',
    });
  });

  it('大小写不敏感', () => {
    expect(parseCompactCommand('/Compact')).toEqual({});
  });

  it('非 compact 命令返回 null', () => {
    expect(parseCompactCommand('/compaction')).toBeNull();
    expect(parseCompactCommand('/goal 修 bug')).toBeNull();
    expect(parseCompactCommand('compact')).toBeNull();
    expect(parseCompactCommand('帮我 /compact')).toBeNull();
  });
});
