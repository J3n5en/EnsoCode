import { describe, expect, it } from 'vitest';
import { parseModelThinkingRef, resolveChildReasoning, thinkingToOverride } from './childReasoning';

describe('resolveChildReasoning', () => {
  it('无覆盖时跟随父会话开关与档位', () => {
    expect(resolveChildReasoning(undefined, true, 'high')).toEqual({
      enabled: true,
      level: 'high',
    });
    expect(resolveChildReasoning({}, false)).toEqual({ enabled: false, level: 'off' });
  });

  it('reasoning:"on" 在父关推理时也开启,档位缺省 medium', () => {
    expect(resolveChildReasoning({ reasoning: 'on' }, false)).toEqual({
      enabled: true,
      level: 'medium',
    });
  });

  it('reasoning:"off" 压过父开启;档位覆盖仅在开启时生效', () => {
    expect(resolveChildReasoning({ reasoning: 'off', thinkingLevel: 'max' }, true, 'high')).toEqual(
      { enabled: false, level: 'off' }
    );
    expect(resolveChildReasoning({ reasoning: 'on', thinkingLevel: 'max' }, false)).toEqual({
      enabled: true,
      level: 'max',
    });
  });

  it('仅档位覆盖:开关跟随父,父开启时档位用覆盖值', () => {
    expect(resolveChildReasoning({ thinkingLevel: 'low' }, true, 'high')).toEqual({
      enabled: true,
      level: 'low',
    });
    expect(resolveChildReasoning({ thinkingLevel: 'low' }, false)).toEqual({
      enabled: false,
      level: 'off',
    });
  });
});

describe('parseModelThinkingRef', () => {
  it('解析 pi 风格 thinking 后缀，非法后缀保持原名', () => {
    expect(parseModelThinkingRef('OpenAI/gpt-cheap:high')).toEqual({
      name: 'OpenAI/gpt-cheap',
      thinking: 'high',
    });
    expect(parseModelThinkingRef('OpenAI/gpt-cheap:off')).toEqual({
      name: 'OpenAI/gpt-cheap',
      thinking: 'off',
    });
    expect(parseModelThinkingRef('OpenAI/gpt-cheap:nope')).toEqual({
      name: 'OpenAI/gpt-cheap:nope',
    });
    expect(parseModelThinkingRef('OpenAI/gpt-cheap')).toEqual({ name: 'OpenAI/gpt-cheap' });
  });
});

describe('thinkingToOverride', () => {
  it('off 关推理，其余开推理并钉死档位', () => {
    expect(thinkingToOverride('off')).toEqual({ reasoning: 'off' });
    expect(thinkingToOverride('xhigh')).toEqual({ reasoning: 'on', thinkingLevel: 'xhigh' });
  });
});
