import { describe, expect, it } from 'vitest';
import {
  searchWorkspace,
  WORKSPACE_SEARCH_RESULT_LIMIT,
  WORKSPACE_SEARCH_SNIPPET_MAX_LENGTH,
  type WorkspaceSearchDoc,
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
