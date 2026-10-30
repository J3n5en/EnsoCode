import { describe, expect, it } from 'vitest';
import { parseMemoryCapture, parseMemorySearchHits } from './memorySearchHits';

const hit = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  title: 'RTK 采用官方 prebuilt',
  content: '随应用分发，默认开启',
  unitType: 'decision',
  spaceId: 'proj:3e8d',
  rank: 1,
  relevance: 0.62,
  isLatest: true,
  ...over,
});

describe('parseMemorySearchHits', () => {
  it('把 Main bridge 投影的 JSON 解析为命中列表，并区分全局/项目空间', () => {
    const output = JSON.stringify({
      results: [
        hit(),
        hit({
          id: 'm2',
          spaceId: 'global',
          unitType: 'preference',
          relevance: undefined,
          score: 0.955,
        }),
      ],
    });
    expect(parseMemorySearchHits(output)).toEqual([
      {
        id: 'm1',
        title: 'RTK 采用官方 prebuilt',
        content: '随应用分发，默认开启',
        unitType: 'decision',
        space: 'project',
        relevance: 0.62,
      },
      {
        id: 'm2',
        title: 'RTK 采用官方 prebuilt',
        content: '随应用分发，默认开启',
        unitType: 'preference',
        space: 'global',
        relevance: null,
      },
    ]);
  });

  it('空结果是合法命中列表，而不是解析失败', () => {
    expect(parseMemorySearchHits('{"results":[]}')).toEqual([]);
  });

  it('可选字段缺失或非法时置空，不拖垮整条结果', () => {
    expect(
      parseMemorySearchHits(
        JSON.stringify({
          results: [hit({ unitType: undefined, spaceId: 'team:x', relevance: 'high' })],
        })
      )
    ).toEqual([
      {
        id: 'm1',
        title: 'RTK 采用官方 prebuilt',
        content: '随应用分发，默认开启',
        unitType: null,
        space: null,
        relevance: null,
      },
    ]);
  });

  it.each([
    ['null', null],
    ['空串', ''],
    ['错误文本', 'Memory is disabled'],
    ['超长输出外置回执', '[output externalized: 40000 chars → /tmp/x.txt]'],
    ['非对象', '[1,2]'],
    ['缺 results', '{"error":"no_project"}'],
    ['results 非数组', '{"results":"x"}'],
    ['条目缺 content', JSON.stringify({ results: [hit({ content: undefined })] })],
    ['条目 id 为空', JSON.stringify({ results: [hit({ id: '' })] })],
    ['条目非对象', '{"results":[null]}'],
  ])('形状不符（%s）返回 null，交给调用方回退原文', (_label, output) => {
    expect(parseMemorySearchHits(output)).toBeNull();
  });
});

describe('parseMemoryCapture', () => {
  const inserted = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      status: 'inserted',
      memory: {
        id: 'm9',
        title: '工具行不能整段隐藏输出',
        unitType: 'learning',
        spaceId: 'proj:3e8d',
        importance: 0.75,
      },
      ...over,
    });

  it('写入成功：回执不带正文，正文取自调用参数', () => {
    expect(parseMemoryCapture(inserted(), '捎带提醒会被一起藏掉')).toEqual({
      written: true,
      deduplicated: false,
      memory: {
        id: 'm9',
        title: '工具行不能整段隐藏输出',
        content: '捎带提醒会被一起藏掉',
        unitType: 'learning',
        space: 'project',
        relevance: null,
      },
    });
    expect(parseMemoryCapture(inserted({ deduplicated: true }), 'x')).toMatchObject({
      written: true,
      deduplicated: true,
    });
  });

  it('发现相似记忆时未写入：列出候选，以相似度作相关度', () => {
    const output = JSON.stringify({
      status: 'candidates_found',
      written: false,
      message: 'Nothing was written: similar memories already exist.',
      candidates: [
        hit({
          id: 'c1',
          spaceId: undefined,
          relevance: undefined,
          similarity: 0.9312,
          bm25Top1: true,
        }),
      ],
    });
    expect(parseMemoryCapture(output, '新正文')).toEqual({
      written: false,
      candidates: [
        {
          id: 'c1',
          title: 'RTK 采用官方 prebuilt',
          content: '随应用分发，默认开启',
          unitType: 'decision',
          space: null,
          relevance: 0.9312,
        },
      ],
    });
  });

  it.each([
    ['错误文本', 'Memory is disabled', 'x'],
    ['写入成功但缺正文参数', inserted(), undefined],
    ['memory 非对象', inserted({ memory: null }), 'x'],
    ['候选非数组', '{"status":"candidates_found","candidates":null}', 'x'],
    ['未知状态', '{"status":"skipped"}', 'x'],
  ])('形状不符（%s）返回 null，交给调用方回退原文', (_label, output, content) => {
    expect(parseMemoryCapture(output, content)).toBeNull();
  });
});
