import { describe, expect, it } from 'vitest';
import {
  MAX_RECENT_MODELS,
  parseRecentModels,
  pushRecentModel,
  removeRecentModel,
} from './recentModels';

const ref = (providerId: string, modelId: string) => ({ providerId, modelId });

describe('最近使用模型', () => {
  it('选中的模型排到最前，已存在的去重前移', () => {
    const list = [ref('a', 'x'), ref('b', 'y')];
    expect(pushRecentModel(list, ref('c', 'z'))).toEqual([
      ref('c', 'z'),
      ref('a', 'x'),
      ref('b', 'y'),
    ]);
    expect(pushRecentModel(list, ref('b', 'y'))).toEqual([ref('b', 'y'), ref('a', 'x')]);
    // provider 不同就是不同条目，不按 modelId 单独去重
    expect(pushRecentModel(list, ref('b', 'x'))).toEqual([
      ref('b', 'x'),
      ref('a', 'x'),
      ref('b', 'y'),
    ]);
  });

  it(`最多保留 ${MAX_RECENT_MODELS} 个，丢掉最旧的`, () => {
    expect(MAX_RECENT_MODELS).toBe(10);
    let list = Array.from({ length: 10 }, (_, i) => ref('p', String(i + 1)));
    list = pushRecentModel(list, ref('p', '11'));
    expect(list.map((entry) => entry.modelId)).toEqual([
      '11',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
  });

  it('依次用过 12 个不同模型：只留最近的 10 个，最近用的排最前', () => {
    let list: ReturnType<typeof pushRecentModel> = [];
    for (let i = 1; i <= 12; i++) list = pushRecentModel(list, ref('p', `m${i}`));
    expect(list.map((entry) => entry.modelId)).toEqual([
      'm12',
      'm11',
      'm10',
      'm9',
      'm8',
      'm7',
      'm6',
      'm5',
      'm4',
      'm3',
    ]);
    // 再用一次较早的模型，它回到最前
    list = pushRecentModel(list, ref('p', 'm5'));
    expect(list.slice(0, 3).map((entry) => entry.modelId)).toEqual(['m5', 'm12', 'm11']);
    expect(list).toHaveLength(10);
  });

  it('只存 providerId/modelId，不带入其他字段', () => {
    const extra = { providerId: 'a', modelId: 'x', apiKey: 'secret' };
    expect(pushRecentModel([], extra)).toEqual([ref('a', 'x')]);
  });

  it('移除只删目标条目，不存在时原样返回', () => {
    const list = [ref('a', 'x'), ref('b', 'y')];
    expect(removeRecentModel(list, ref('a', 'x'))).toEqual([ref('b', 'y')]);
    expect(removeRecentModel(list, ref('a', 'y'))).toEqual(list);
  });

  it('读入时丢弃脏数据、去重并截断', () => {
    expect(parseRecentModels(undefined)).toEqual([]);
    expect(parseRecentModels('a/x')).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => ref('p', String(i + 1)));
    expect(
      parseRecentModels([
        ref('a', 'x'),
        null,
        'a/x',
        { providerId: 'a' },
        { providerId: '', modelId: 'x' },
        { providerId: 1, modelId: 'x' },
        { ...ref('a', 'x'), extra: true },
        ...many,
      ])
    ).toEqual([ref('a', 'x'), ...many.slice(0, 9)]);
  });
});
