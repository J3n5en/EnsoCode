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
    expect(MAX_RECENT_MODELS).toBe(5);
    let list = [ref('p', '1'), ref('p', '2'), ref('p', '3'), ref('p', '4'), ref('p', '5')];
    list = pushRecentModel(list, ref('p', '6'));
    expect(list.map((entry) => entry.modelId)).toEqual(['6', '1', '2', '3', '4']);
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
    expect(
      parseRecentModels([
        ref('a', 'x'),
        null,
        'a/x',
        { providerId: 'a' },
        { providerId: '', modelId: 'x' },
        { providerId: 1, modelId: 'x' },
        { ...ref('a', 'x'), extra: true },
        ref('p', '1'),
        ref('p', '2'),
        ref('p', '3'),
        ref('p', '4'),
        ref('p', '5'),
      ])
    ).toEqual([ref('a', 'x'), ref('p', '1'), ref('p', '2'), ref('p', '3'), ref('p', '4')]);
  });
});
