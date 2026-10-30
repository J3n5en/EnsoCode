import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MemoryCaptureResult, MemorySearchResults } from './MemorySearchResults';
import type { MemoryCaptureView, MemorySearchHit } from './memorySearchHits';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => `[${key}]` }) }));

const render = (hits: MemorySearchHit[]): string =>
  renderToStaticMarkup(createElement(MemorySearchResults, { hits }));

const hit = (over: Partial<MemorySearchHit> = {}): MemorySearchHit => ({
  id: 'm1',
  title: 'RTK 采用官方 prebuilt',
  content: '随应用分发，默认开启',
  unitType: 'decision',
  space: 'project',
  relevance: 0.6112,
  ...over,
});

describe('MemorySearchResults', () => {
  it('每条命中展示标题、类型、空间、原始相关度与正文，默认折叠', () => {
    const html = render([
      hit(),
      hit({ id: 'm2', title: '全局偏好', space: 'global', relevance: -0.05 }),
    ]);

    expect(html).toContain('RTK 采用官方 prebuilt');
    expect(html).toContain('随应用分发，默认开启');
    expect(html).toContain('decision');
    expect(html).toContain('[Project]');
    expect(html).toContain('[Global]');
    expect(html).toContain('0.61');
    expect(html).toContain('-0.05');
    expect(html).toContain('[Semantic similarity]');
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('line-clamp-2');
    expect(html).not.toContain('spaceId');
  });

  it('可选元数据缺失时不渲染空徽标；没有原始相关度就不显示数字', () => {
    const html = render([hit({ unitType: null, space: null, relevance: null })]);

    expect(html).not.toContain('[Project]');
    expect(html).not.toContain('[Global]');
    expect(html).not.toContain('decision');
    expect(html).not.toContain('tabular-nums');
  });

  it('空结果显示无匹配提示，而不是空白卡片', () => {
    expect(render([])).toContain('[No results]');
  });
});

describe('MemoryCaptureResult', () => {
  const renderCapture = (view: MemoryCaptureView): string =>
    renderToStaticMarkup(createElement(MemoryCaptureResult, { view }));

  it('写入成功：这一条默认展开，不用再点一次', () => {
    const html = renderCapture({
      written: true,
      deduplicated: false,
      memory: hit({ relevance: null }),
    });

    expect(html).toContain('RTK 采用官方 prebuilt');
    expect(html).toContain('随应用分发，默认开启');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('line-clamp-2');
    expect(html).not.toContain('already exist');
  });

  it('内容与已有记忆完全相同时注明没有重复写入', () => {
    const html = renderCapture({ written: true, deduplicated: true, memory: hit() });

    expect(html).toContain('[Identical memory already exists, nothing new was written]');
  });

  it('未写入：说明原因，并列出挡住它的相似记忆（默认折叠）', () => {
    const html = renderCapture({ written: false, candidates: [hit(), hit({ id: 'm2' })] });

    expect(html).toContain('[Similar memories already exist, nothing was written]');
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).not.toContain('aria-expanded="true"');
  });
});
