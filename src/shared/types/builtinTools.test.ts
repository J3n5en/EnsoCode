import { describe, expect, it } from 'vitest';
import { effectiveDisabledBuiltinTools } from './builtinTools';

describe('effectiveDisabledBuiltinTools', () => {
  it('缺字段时用默认关闭列表（空 = 全开）', () => {
    expect(effectiveDisabledBuiltinTools(undefined)).toEqual([]);
  });

  it('只保留字符串 id，列表原样透传', () => {
    expect(effectiveDisabledBuiltinTools(['browser', 1, 'isolated_sandbox'])).toEqual([
      'browser',
      'isolated_sandbox',
    ]);
  });
});
