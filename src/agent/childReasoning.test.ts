import { describe, expect, it } from 'vitest';
import {
  fitChildReasoningToModel,
  parseModelThinkingRef,
  pickChildReasoningOverride,
  resolveChildReasoning,
  resolveChildThinkingInput,
  thinkingToOverride,
} from './childReasoning';

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

describe('fitChildReasoningToModel', () => {
  it('模型不支持思考时关掉，不把类型档强行打开', () => {
    expect(fitChildReasoningToModel({ enabled: true, level: 'low' }, { reasoning: false })).toEqual(
      { enabled: false, level: 'off' }
    );
  });

  it('档位超出模型声明时钳到可用档，不抛错', () => {
    expect(
      fitChildReasoningToModel(
        { enabled: true, level: 'high' },
        { reasoning: true, thinkingLevelMap: { medium: null, high: null } }
      )
    ).toEqual({ enabled: true, level: 'low' });
  });

  it('没有档位表时保持决定，交给 pi 自己钳', () => {
    expect(
      fitChildReasoningToModel({ enabled: true, level: 'xhigh' }, { reasoning: true })
    ).toEqual({ enabled: true, level: 'xhigh' });
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

describe('resolveChildThinkingInput', () => {
  it('显式 thinking 赢过模型后缀，空模型名归一为未指定', () => {
    expect(resolveChildThinkingInput('OpenAI/gpt-cheap:high', 'off')).toEqual({
      modelName: 'OpenAI/gpt-cheap',
      thinking: 'off',
    });
    expect(resolveChildThinkingInput('   ', 'xhigh')).toEqual({
      modelName: undefined,
      thinking: 'xhigh',
    });
  });

  it('非法显式 thinking 使用既有精确错误文本', () => {
    expect(() => resolveChildThinkingInput('OpenAI/gpt-cheap:high', 'ultra')).toThrow(
      'unknown thinking "ultra". Available: [off, minimal, low, medium, high, xhigh, max] or omit to inherit.'
    );
  });
});

describe('pickChildReasoningOverride', () => {
  it('派发 thinking 赢过类型预设', () => {
    expect(pickChildReasoningOverride('off', { reasoning: 'on', thinkingLevel: 'high' })).toEqual({
      reasoning: 'off',
    });
  });

  it('无派发时取类型预设，缺省字段不填', () => {
    expect(pickChildReasoningOverride(undefined, { thinkingLevel: 'high' })).toEqual({
      thinkingLevel: 'high',
    });
    expect(pickChildReasoningOverride(undefined, undefined)).toEqual({});
  });
});

describe('子代理思考档优先级：派发 > 类型预设 > 父会话 > 模型条目预设', () => {
  const entryMax = { reasoning: 'on' as const, thinkingLevel: 'max' as const };
  const level = (
    dispatched: Parameters<typeof pickChildReasoningOverride>[0],
    typePreset: Parameters<typeof pickChildReasoningOverride>[1],
    parentEnabled: boolean,
    parentLevel: Parameters<typeof resolveChildReasoning>[2],
    entry: Parameters<typeof resolveChildReasoning>[3]
  ) =>
    resolveChildReasoning(
      pickChildReasoningOverride(dispatched, typePreset),
      parentEnabled,
      parentLevel,
      entry
    ).level;

  it('父会话当前档赢过模型条目预设', () => {
    expect(level(undefined, undefined, true, 'high', entryMax)).toBe('high');
  });

  it('父会话关闭推理时回落到模型条目预设', () => {
    expect(level(undefined, undefined, false, undefined, entryMax)).toBe('max');
  });

  it('父开启但无档位时用模型条目档位', () => {
    expect(level(undefined, undefined, true, undefined, entryMax)).toBe('max');
  });

  it('模型条目关闭推理压不过父会话开启', () => {
    expect(level(undefined, undefined, true, 'high', { reasoning: 'off' })).toBe('high');
  });

  it('派发显式档仍最高', () => {
    expect(level('low', { thinkingLevel: 'medium' }, true, 'high', entryMax)).toBe('low');
  });

  it('类型预设仍高于父会话', () => {
    expect(level(undefined, { thinkingLevel: 'medium' }, true, 'high', entryMax)).toBe('medium');
  });

  it('全都没设时走原默认：父关 → off，强开 → medium', () => {
    expect(level(undefined, undefined, false, undefined, undefined)).toBe('off');
    expect(level(undefined, { reasoning: 'on' }, false, undefined, undefined)).toBe('medium');
  });
});

describe('thinkingToOverride', () => {
  it('off 关推理，其余开推理并钉死档位', () => {
    expect(thinkingToOverride('off')).toEqual({ reasoning: 'off' });
    expect(thinkingToOverride('xhigh')).toEqual({ reasoning: 'on', thinkingLevel: 'xhigh' });
  });
});
