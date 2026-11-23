import { describe, expect, it } from 'vitest';
import {
  cycleWorkspaceSearchScope,
  highlightWorkspaceMatches,
  mergeWorkspaceHits,
  searchWorkspace,
  WORKSPACE_SEARCH_RESULT_LIMIT,
  WORKSPACE_SEARCH_SNIPPET_MAX_LENGTH,
  type WorkspaceSearchDoc,
  type WorkspaceSearchHit,
} from './workspaceSearch';

function doc(
  overrides: Partial<WorkspaceSearchDoc> & Pick<WorkspaceSearchDoc, 'conversationId'>
): WorkspaceSearchDoc {
  return {
    projectId: 'proj-a',
    projectName: 'Project A',
    title: 'untitled',
    lastActiveAt: 1000,
    fields: [{ field: 'title', text: overrides.title ?? 'untitled' }],
    ...overrides,
  };
}

const baseOptions = { currentProjectId: 'proj-a', scope: 'project' as const };

describe('searchWorkspace 排序', () => {
  it('正文命中的摘要不露引用块标签', () => {
    const docs = [
      doc({
        conversationId: 'c1',
        fields: [{ field: 'body', text: '<quote>\n引用里的 term\n</quote>\n追问' }],
      }),
    ];
    const [hit] = searchWorkspace(docs, 'term', baseOptions);
    expect(hit?.snippet).not.toMatch(/<\/?quote/);
    expect(hit?.snippet).toContain('引用里的 term');
  });

  it('标题精确匹配排在标题包含匹配之前', () => {
    const docs = [
      doc({ conversationId: 'c1', title: 'hello world contains term' }),
      doc({ conversationId: 'c2', title: 'term' }),
    ];
    const hits = searchWorkspace(docs, 'term', baseOptions);
    expect(hits.map((h) => h.conversationId)).toEqual(['c2', 'c1']);
  });

  it('标题包含匹配排在当前项目正文匹配之前', () => {
    const docs = [
      doc({
        conversationId: 'c1',
        title: 'unrelated',
        fields: [{ field: 'body', text: 'contains term in body' }],
      }),
      doc({ conversationId: 'c2', title: 'has term in title' }),
    ];
    const hits = searchWorkspace(docs, 'term', baseOptions);
    expect(hits.map((h) => h.conversationId)).toEqual(['c2', 'c1']);
  });

  it('当前项目正文匹配排在其他项目正文匹配之前', () => {
    const docs = [
      doc({
        conversationId: 'c1',
        projectId: 'proj-b',
        title: 'unrelated',
        fields: [{ field: 'body', text: 'contains term in body' }],
      }),
      doc({
        conversationId: 'c2',
        projectId: 'proj-a',
        title: 'unrelated',
        fields: [{ field: 'body', text: 'contains term in body' }],
      }),
    ];
    const hits = searchWorkspace(docs, 'term', { currentProjectId: 'proj-a', scope: 'all' });
    expect(hits.map((h) => h.conversationId)).toEqual(['c2', 'c1']);
  });

  it('同分时按 lastActiveAt 降序排列', () => {
    const docs = [
      doc({ conversationId: 'c1', title: 'term', lastActiveAt: 1000 }),
      doc({ conversationId: 'c2', title: 'term', lastActiveAt: 2000 }),
    ];
    const hits = searchWorkspace(docs, 'term', baseOptions);
    expect(hits.map((h) => h.conversationId)).toEqual(['c2', 'c1']);
  });
});

describe('searchWorkspace 分词与匹配', () => {
  it('CJK 使用子串匹配', () => {
    const docs = [doc({ conversationId: 'c1', title: '这是一个中文标题测试' })];
    const hits = searchWorkspace(docs, '标题测', baseOptions);
    expect(hits.map((h) => h.conversationId)).toEqual(['c1']);
  });

  it('拉丁词使用 token 前缀匹配', () => {
    const docs = [doc({ conversationId: 'c1', title: 'workspace search dialog' })];
    const hits = searchWorkspace(docs, 'sear', baseOptions);
    expect(hits.map((h) => h.conversationId)).toEqual(['c1']);
  });

  it('拉丁词前缀匹配不跨 token 命中中间片段', () => {
    const docs = [doc({ conversationId: 'c1', title: 'workspace search dialog' })];
    const hits = searchWorkspace(docs, 'earch', baseOptions);
    expect(hits.map((h) => h.conversationId)).toEqual([]);
  });

  it('大小写不敏感', () => {
    const docs = [doc({ conversationId: 'c1', title: 'WorkSpace Search' })];
    const hits = searchWorkspace(docs, 'workspace', baseOptions);
    expect(hits.map((h) => h.conversationId)).toEqual(['c1']);
  });

  it('标点被当作分隔符，连字符不改变分词结果', () => {
    const docs = [doc({ conversationId: 'c1', title: 'mod-k shortcut' })];
    const hits = searchWorkspace(docs, 'mod', baseOptions);
    expect(hits.map((h) => h.conversationId)).toEqual(['c1']);
  });

  it('查询里的引号不被当作查询语法（不抛异常，按字面消毒后匹配）', () => {
    const docs = [doc({ conversationId: 'c1', title: 'say "hello" world' })];
    expect(() => searchWorkspace(docs, '"hello"', baseOptions)).not.toThrow();
    const hits = searchWorkspace(docs, '"hello"', baseOptions);
    expect(hits.map((h) => h.conversationId)).toEqual(['c1']);
  });
});

describe('searchWorkspace 范围过滤', () => {
  const docs = [
    doc({ conversationId: 'c1', projectId: 'proj-a', title: 'term one' }),
    doc({ conversationId: 'c2', projectId: 'proj-b', title: 'term two' }),
    doc({ conversationId: 'c3', projectId: 'proj-a', title: 'term three', archived: true }),
  ];

  it('scope=project 只返回当前项目、非归档', () => {
    const hits = searchWorkspace(docs, 'term', { currentProjectId: 'proj-a', scope: 'project' });
    expect(hits.map((h) => h.conversationId).sort()).toEqual(['c1']);
  });

  it('scope=all 返回所有项目，仍不含归档', () => {
    const hits = searchWorkspace(docs, 'term', { currentProjectId: 'proj-a', scope: 'all' });
    expect(hits.map((h) => h.conversationId).sort()).toEqual(['c1', 'c2']);
  });

  it('scope=all-including-archived 含归档会话', () => {
    const hits = searchWorkspace(docs, 'term', {
      currentProjectId: 'proj-a',
      scope: 'all-including-archived',
    });
    expect(hits.map((h) => h.conversationId).sort()).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('searchWorkspace 排除规则', () => {
  it('排除空草稿会话', () => {
    const docs = [doc({ conversationId: 'c1', title: 'term draft', isDraftEmpty: true })];
    const hits = searchWorkspace(docs, 'term', baseOptions);
    expect(hits).toEqual([]);
  });

  it('命中会标记 isCurrent（来自文档的 isCurrent）', () => {
    const docs = [doc({ conversationId: 'c1', title: 'term', isCurrent: true })];
    const hits = searchWorkspace(docs, 'term', baseOptions);
    expect(hits[0]?.isCurrent).toBe(true);
  });
});

describe('searchWorkspace 结果上限与 snippet', () => {
  it('结果数不超过 50 条', () => {
    const docs = Array.from({ length: 80 }, (_, i) =>
      doc({ conversationId: `c${i}`, title: `term ${i}` })
    );
    const hits = searchWorkspace(docs, 'term', baseOptions);
    expect(hits.length).toBeLessThanOrEqual(WORKSPACE_SEARCH_RESULT_LIMIT);
  });

  it('snippet 长度不超过 160 字', () => {
    const longText = `term ${'x'.repeat(400)}`;
    const docs = [
      doc({
        conversationId: 'c1',
        title: 'unrelated',
        fields: [{ field: 'body', text: longText }],
      }),
    ];
    const hits = searchWorkspace(docs, 'term', baseOptions);
    expect(hits[0]?.snippet.length).toBeLessThanOrEqual(WORKSPACE_SEARCH_SNIPPET_MAX_LENGTH);
  });
});

describe('searchWorkspace nearby（命中句子前后各最多 2 句）', () => {
  // 约定：nearby 由命中所在 field 的文本按句号/问号/感叹号（含中文标点）切句，
  // 取命中句前后各至多 2 句，不含命中句本身；句子数不足时按实际数量返回。
  it('句子数充足时，nearby 返回命中前后各 2 句', () => {
    const text = 'One. Two. Three term four. Five. Six. Seven.';
    const docs = [
      doc({ conversationId: 'c1', title: 'unrelated', fields: [{ field: 'body', text }] }),
    ];
    const hits = searchWorkspace(docs, 'term', baseOptions);
    expect(hits[0]?.nearby).toEqual(['Two.', 'One.', 'Five.', 'Six.']);
  });

  it('命中句附近句子不足 2 句时按实际数量返回', () => {
    const text = 'Only term sentence here. Second sentence.';
    const docs = [
      doc({ conversationId: 'c1', title: 'unrelated', fields: [{ field: 'body', text }] }),
    ];
    const hits = searchWorkspace(docs, 'term', baseOptions);
    expect(hits[0]?.nearby).toEqual(['Second sentence.']);
  });
});

describe('searchWorkspace 空查询', () => {
  it('空字符串查询返回空数组（最近会话列表由 UI 层负责，不在本函数职责内）', () => {
    const docs = [doc({ conversationId: 'c1', title: 'term' })];
    const hits = searchWorkspace(docs, '', baseOptions);
    expect(hits).toEqual([]);
  });

  it('纯空白查询返回空数组', () => {
    const docs = [doc({ conversationId: 'c1', title: 'term' })];
    const hits = searchWorkspace(docs, '   ', baseOptions);
    expect(hits).toEqual([]);
  });
});

describe('searchWorkspace 会话 id', () => {
  const id = '311fca9f-e4d4-499f-a979-03d34cb276d9';
  const docs = [
    doc({
      conversationId: id,
      title: 'unrelated',
      fields: [
        { field: 'title', text: 'unrelated' },
        { field: 'id', text: id },
      ],
    }),
  ];

  it('按整个 id 的前缀命中', () => {
    expect(searchWorkspace(docs, '311FCA9F-e4', baseOptions)[0]?.field).toBe('id');
  });

  it('不命中 id 中间段', () => {
    expect(searchWorkspace(docs, 'e4d4', baseOptions)).toEqual([]);
    expect(searchWorkspace(docs, 'a', baseOptions)).toEqual([]);
  });
});

describe('mergeWorkspaceHits（热命中 + Main 冷命中）', () => {
  const coldHit = (conversationId: string, snippet = 'cold term body'): WorkspaceSearchHit => ({
    conversationId,
    projectId: 'proj-a',
    title: '<raw first message>',
    field: 'body',
    snippet,
  });

  it('冷命中的标题、归档、当前、父会话以本地投影为准', () => {
    const docs = [
      doc({
        conversationId: 'c1',
        title: '多角度调研',
        isCurrent: true,
        parentConversationId: 'p',
      }),
    ];
    const [hit] = mergeWorkspaceHits(docs, [], [coldHit('c1')], 'term', baseOptions);
    expect(hit).toMatchObject({
      conversationId: 'c1',
      title: '多角度调研',
      field: 'body',
      snippet: 'cold term body',
      isCurrent: true,
      parentConversationId: 'p',
    });
  });

  it('本地投影里没有的会话（打不开）丢弃', () => {
    expect(mergeWorkspaceHits([], [], [coldHit('ghost')], 'term', baseOptions)).toEqual([]);
  });

  it('冷命中按范围过滤归档与草稿', () => {
    const docs = [
      doc({ conversationId: 'archived', archived: true }),
      doc({ conversationId: 'draft', isDraftEmpty: true }),
    ];
    const cold = [coldHit('archived'), coldHit('draft')];
    const all = { ...baseOptions, scope: 'all' as const };
    expect(mergeWorkspaceHits(docs, [], cold, 'term', all)).toEqual([]);
    const withArchived = mergeWorkspaceHits(docs, [], cold, 'term', {
      ...baseOptions,
      scope: 'all-including-archived',
    });
    expect(withArchived.map((hit) => [hit.conversationId, hit.archived])).toEqual([
      ['archived', true],
    ]);
  });

  it('同一会话热命中优先', () => {
    const docs = [doc({ conversationId: 'c1', title: 'term' })];
    const hot = searchWorkspace(docs, 'term', baseOptions);
    const merged = mergeWorkspaceHits(docs, hot, [coldHit('c1')], 'term', baseOptions);
    expect(merged.map((hit) => hit.field)).toEqual(['title']);
  });

  it('合并后按同一排序规则重排：当前项目正文排在其他项目正文之前', () => {
    const docs = [
      doc({
        conversationId: 'other-hot',
        projectId: 'proj-b',
        lastActiveAt: 9000,
        fields: [{ field: 'body', text: 'term in other project' }],
      }),
      doc({ conversationId: 'current-cold', lastActiveAt: 1000 }),
    ];
    const options = { ...baseOptions, scope: 'all' as const };
    const hot = searchWorkspace(docs, 'term', options);
    const merged = mergeWorkspaceHits(docs, hot, [coldHit('current-cold')], 'term', options);
    expect(merged.map((hit) => hit.conversationId)).toEqual(['current-cold', 'other-hot']);
  });
});

describe('cycleWorkspaceSearchScope', () => {
  it('Tab 依次 当前项目 → 全部项目 → 含归档 → 当前项目', () => {
    expect(cycleWorkspaceSearchScope('project')).toBe('all');
    expect(cycleWorkspaceSearchScope('all')).toBe('all-including-archived');
    expect(cycleWorkspaceSearchScope('all-including-archived')).toBe('project');
  });

  it('Shift+Tab 反向', () => {
    expect(cycleWorkspaceSearchScope('project', true)).toBe('all-including-archived');
    expect(cycleWorkspaceSearchScope('all', true)).toBe('project');
  });
});

describe('highlightWorkspaceMatches', () => {
  const marked = (text: string, query: string) =>
    highlightWorkspaceMatches(text, query)
      .map((part) => (part.match ? `[${part.text}]` : part.text))
      .join('');

  it('按词首前缀大小写不敏感高亮，与搜索命中规则一致', () => {
    expect(marked('Cart discount logic', 'cart DIS')).toBe('[Cart] [dis]count logic');
  });

  it('不高亮词中间的片段', () => {
    expect(marked('recart discount', 'cart count')).toBe('recart discount');
  });

  it('同一个词出现多次时全部高亮', () => {
    expect(marked('fix cart, then cart-test', 'cart')).toBe('fix [cart], then [cart]-test');
  });

  it('中文按子串高亮', () => {
    expect(marked('修复购物车折扣逻辑', '折扣')).toBe('修复购物车[折扣]逻辑');
  });

  it('重叠的查询词合并为一段', () => {
    expect(marked('cart', 'ca cart')).toBe('[cart]');
  });

  it('空查询或无命中返回原文', () => {
    expect(highlightWorkspaceMatches('Cart', '  ')).toEqual([{ text: 'Cart', match: false }]);
    expect(highlightWorkspaceMatches('Cart', 'zzz')).toEqual([{ text: 'Cart', match: false }]);
  });
});
