import { describe, expect, it } from 'vitest';
import { mergeFetchedModels } from './modelEntry';
import type { ModelEntry } from './types';

describe('mergeFetchedModels', () => {
  it('新模型追加为启用条目并携带元数据', () => {
    const merged = mergeFetchedModels(
      [],
      [{ id: 'grok-4.6', contextWindow: 256000 }, { id: 'plain' }]
    );
    expect(merged).toEqual([
      { id: 'grok-4.6', enabled: true, contextWindow: 256000 },
      { id: 'plain', enabled: true },
    ]);
  });

  it('已有模型仅回填缺失字段，不覆盖已有值', () => {
    const current: ModelEntry[] = [
      { id: 'kept', enabled: false, contextWindow: 80000 },
      { id: 'backfill', enabled: true },
    ];
    const merged = mergeFetchedModels(current, [
      { id: 'kept', contextWindow: 256000, maxTokens: 32000 },
      { id: 'backfill', contextWindow: 128000, maxTokens: 8192 },
    ]);
    expect(merged).toEqual([
      // contextWindow 已有 → 保留 80000；maxTokens 缺失 → 回填
      { id: 'kept', enabled: false, contextWindow: 80000, maxTokens: 32000 },
      { id: 'backfill', enabled: true, contextWindow: 128000, maxTokens: 8192 },
    ]);
  });

  it('保持已有顺序，新模型排在末尾；fetched 无元数据时已有条目原样返回', () => {
    const current: ModelEntry[] = [{ id: 'a' }, { id: 'b', label: 'B' }];
    const merged = mergeFetchedModels(current, [{ id: 'b' }, { id: 'new' }]);
    expect(merged).toEqual([{ id: 'a' }, { id: 'b', label: 'B' }, { id: 'new', enabled: true }]);
  });
});
