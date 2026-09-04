import { describe, expect, it } from 'vitest';
import {
  charsToTokens,
  estimateInstructionTokens,
  estimateSkillTokens,
  estimateToolTokens,
} from './occupancy';

describe('charsToTokens', () => {
  it('字符按 /4 估算，向上取整', () => {
    expect(charsToTokens(0)).toBe(0);
    expect(charsToTokens(-3)).toBe(0);
    expect(charsToTokens(1)).toBe(1);
    expect(charsToTokens(4)).toBe(1);
    expect(charsToTokens(5)).toBe(2);
  });
});

describe('estimateSkillTokens', () => {
  it('name + description + content 与会话占用同一串', () => {
    expect(estimateSkillTokens({ name: 'ab', description: 'cd', content: 'ef' })).toBe(
      charsToTokens('ab cd ef'.length)
    );
  });

  it('缺 description/content 当空串，脏输入不崩', () => {
    expect(estimateSkillTokens({ name: '' })).toBe(charsToTokens('  '.length));
    expect(estimateSkillTokens({ name: 'x', description: undefined, content: undefined })).toBe(
      charsToTokens('x  '.length)
    );
  });
});

describe('estimateToolTokens', () => {
  it('parameters 序列化进估算', () => {
    const parameters = { type: 'object', properties: { q: { type: 'string' } } };
    expect(estimateToolTokens({ name: 'search', description: 'find', parameters })).toBe(
      charsToTokens(`search find ${JSON.stringify(parameters)}`.length)
    );
  });

  it('parameters 缺省不拼 undefined', () => {
    expect(estimateToolTokens({ name: 'x', description: 'y' })).toBe(charsToTokens('x y '.length));
  });
});

describe('estimateInstructionTokens', () => {
  it('按正文长度估算', () => {
    expect(estimateInstructionTokens('abcd')).toBe(1);
    expect(estimateInstructionTokens('')).toBe(0);
  });
});
