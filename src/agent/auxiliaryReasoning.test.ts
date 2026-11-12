import { describe, expect, it } from 'vitest';
import { auxiliaryReasoning } from './auxiliaryReasoning';

describe('auxiliaryReasoning', () => {
  it('模型配了推理开启时给默认档位，避免以 off 发送', () => {
    expect(auxiliaryReasoning({ reasoning: 'on' })).toBe('medium');
  });

  it('模型还配了档位覆盖时用覆盖值', () => {
    expect(auxiliaryReasoning({ reasoning: 'on', thinkingLevel: 'high' })).toBe('high');
  });

  it('推理关闭或未配置时不带推理参数', () => {
    expect(auxiliaryReasoning({ reasoning: 'off' })).toBeUndefined();
    expect(auxiliaryReasoning({})).toBeUndefined();
    expect(auxiliaryReasoning(undefined)).toBeUndefined();
  });
});
