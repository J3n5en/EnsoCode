import { describe, expect, it } from 'vitest';
import { titleModelCandidates } from './titleSummary';

const state = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  titleSummaryEnabled: true,
  titleSummaryModel: { providerId: 'title-p', modelId: 'title-m' },
  defaultModel: { providerId: 'default-p', modelId: 'default-m' },
  ...over,
});

describe('titleModelCandidates：标题模型 → 全局默认的回退链', () => {
  it('独立标题模型排在全局默认之前', () => {
    expect(titleModelCandidates(state())).toEqual([
      { providerId: 'title-p', modelId: 'title-m' },
      { providerId: 'default-p', modelId: 'default-m' },
    ]);
  });

  it('未选独立模型（null）时只剩全局默认', () => {
    expect(titleModelCandidates(state({ titleSummaryModel: null }))).toEqual([
      { providerId: 'default-p', modelId: 'default-m' },
    ]);
  });

  it('标题模型与全局默认相同则去重，不重复尝试', () => {
    expect(
      titleModelCandidates(
        state({ titleSummaryModel: { providerId: 'default-p', modelId: 'default-m' } })
      )
    ).toEqual([{ providerId: 'default-p', modelId: 'default-m' }]);
  });

  it('两者都没有时返回空数组（本次静默跳过）', () => {
    expect(titleModelCandidates(state({ titleSummaryModel: null, defaultModel: null }))).toEqual(
      []
    );
  });

  // settings.json 是用户机器上的真实文件，可能被手改坏
  it('字段形状坏掉（缺 modelId / 非对象 / 非字符串）时逐项跳过不崩', () => {
    expect(
      titleModelCandidates(
        state({
          titleSummaryModel: { providerId: 'p' },
          defaultModel: 'broken',
        })
      )
    ).toEqual([]);
    expect(
      titleModelCandidates(
        state({
          titleSummaryModel: { providerId: 42, modelId: 'm' },
          defaultModel: { providerId: 'default-p', modelId: 'default-m' },
        })
      )
    ).toEqual([{ providerId: 'default-p', modelId: 'default-m' }]);
  });

  it('整个 state 缺失时返回空数组', () => {
    expect(titleModelCandidates(undefined)).toEqual([]);
  });
});
