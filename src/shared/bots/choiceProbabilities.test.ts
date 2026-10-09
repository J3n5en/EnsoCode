import { describe, expect, it } from 'vitest';
import { validChoiceProbabilities } from './choiceProbabilities';

const keys = ['a', 'b', 'end'];

describe('validChoiceProbabilities', () => {
  it('合法表原样返回（不补键、不归一化）', () => {
    expect(validChoiceProbabilities({ a: 0.7, b: 0.1, end: 0.2 }, keys)).toEqual({
      a: 0.7,
      b: 0.1,
      end: 0.2,
    });
    expect(validChoiceProbabilities({ a: 0.9 }, keys)).toEqual({ a: 0.9 });
    expect(validChoiceProbabilities({ b: 0.3 }, keys)).toEqual({ b: 0.3 });
    expect(validChoiceProbabilities({ a: 0.51, b: 0.25, end: 0.25 }, keys)).toEqual({
      a: 0.51,
      b: 0.25,
      end: 0.25,
    });
  });

  it('总和上限 = 1 + 0.005 × 已返回选项数 + 1e-9', () => {
    expect(validChoiceProbabilities({ a: 0.34, b: 0.34, end: 0.335 }, keys)).not.toBeNull();
    expect(validChoiceProbabilities({ a: 0.34, b: 0.34, end: 0.336 }, keys)).toBeNull();
    expect(validChoiceProbabilities({ a: 0.5, b: 0.51 }, keys)).not.toBeNull();
    expect(validChoiceProbabilities({ a: 0.5, b: 0.511 }, keys)).toBeNull();
    expect(validChoiceProbabilities({ a: 1.0 }, keys)).not.toBeNull();
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['数组', [1]],
    ['数字', 1],
    ['空表', {}],
    ['名单外键', { ghost: 1 }],
    ['名单外键混在合法值里', { a: 0.5, ghost: 0.1 }],
    ['负数', { a: -0.1, b: 0.5 }],
    ['大于 1', { a: 1.2 }],
    ['越界组合', { a: -1, b: 2 }],
    ['NaN', { a: Number.NaN, b: 0.5 }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
    ['非数字', { a: '0.9' }],
    ['全 0', { a: 0, b: 0, end: 0 }],
    ['超额', { a: 0.7, b: 0.2, end: 0.2 }],
  ])('不合法：%s', (_label, probabilities) => {
    expect(validChoiceProbabilities(probabilities, keys)).toBeNull();
  });
});
