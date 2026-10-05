import { describe, expect, it } from 'vitest';
import { mentionCandidates, namedMentions, parseMentions } from './mentions';

const members = [
  { id: 'a', name: '阿后' },
  { id: 'b', name: 'Bob' },
  { id: 'c', name: '阿后端' },
  { id: 'd', name: 'qa-1' },
];

describe('parseMentions', () => {
  it('按出现顺序识别并去重', () => {
    expect(parseMentions('@Bob 你先，然后 @阿后 再 @bob', members)).toEqual({
      ids: ['b', 'a'],
      all: false,
    });
  });

  it('名字匹配不分大小写', () => {
    expect(parseMentions('@BOB @QA-1', members).ids).toEqual(['b', 'd']);
  });

  it('中文名后不需要空格，且取已知成员名的最长匹配', () => {
    expect(parseMentions('@阿后先做', members).ids).toEqual(['a']);
    expect(parseMentions('@阿后端看下', members).ids).toEqual(['c']);
  });

  it('中文字符紧贴在 @ 前面仍算提及', () => {
    expect(parseMentions('请@Bob看下', members).ids).toEqual(['b']);
  });

  it('英文名后紧跟英文字母不算提及（@Bobby 不是 Bob）', () => {
    expect(parseMentions('@Bobby hi', members).ids).toEqual([]);
    expect(parseMentions('@Bob, hi', members).ids).toEqual(['b']);
  });

  it('邮箱里的 @ 不算提及', () => {
    expect(parseMentions('发到 x@bob.com 或 bob_1@Bob', members).ids).toEqual([]);
  });

  it('代码块和行内代码里的 @ 忽略', () => {
    const text = '看 `@Bob` 和\n```\n@阿后\n```\n最后 @qa-1';
    expect(parseMentions(text, members).ids).toEqual(['d']);
  });

  it('未闭合的代码块到结尾都视为代码', () => {
    expect(parseMentions('```\n@Bob', members).ids).toEqual([]);
  });

  it('@所有人 / @everyone / @all 展开为全部成员并按成员顺序', () => {
    for (const word of ['所有人', 'Everyone', 'ALL']) {
      expect(parseMentions(`@qa-1 @${word}`, members)).toEqual({
        ids: ['a', 'b', 'c', 'd'],
        all: true,
      });
    }
  });

  it('@allen 不算 @all', () => {
    expect(parseMentions('@allen', members).all).toBe(false);
  });

  it('未知名字与孤立的 @ 被忽略', () => {
    expect(parseMentions('@张三 @ @', members)).toEqual({ ids: [], all: false });
  });

  it('脏输入不崩', () => {
    expect(parseMentions(null as never, members)).toEqual({ ids: [], all: false });
    expect(parseMentions('@Bob', null as never)).toEqual({ ids: [], all: false });
    const dirty = [null, { id: 'x' }, { id: 'y', name: '' }, { id: 'b', name: 'Bob' }];
    expect(parseMentions('@Bob', dirty as never)).toEqual({ ids: ['b'], all: false });
  });

  it('没有成员时 @所有人 也不产生 id', () => {
    expect(parseMentions('@所有人', [])).toEqual({ ids: [], all: true });
  });
});

describe('namedMentions', () => {
  it('只返回点名的成员，@所有人 不展开', () => {
    expect(namedMentions('@所有人 @Bob @阿后', members)).toEqual(['b', 'a']);
    expect(namedMentions('@everyone', members)).toEqual([]);
    expect(namedMentions(null as never, members)).toEqual([]);
  });
});

describe('mentionCandidates', () => {
  it('按前缀不分大小写过滤并保持成员顺序', () => {
    expect(mentionCandidates('阿后', members).map((m) => m.id)).toEqual(['a', 'c']);
    expect(mentionCandidates('bO', members).map((m) => m.id)).toEqual(['b']);
  });

  it('前缀带 @ 或为空时也能用', () => {
    expect(mentionCandidates('@q', members).map((m) => m.id)).toEqual(['d']);
    expect(mentionCandidates('', members)).toHaveLength(4);
  });

  it('脏输入不崩', () => {
    expect(mentionCandidates(undefined as never, null as never)).toEqual([]);
  });
});
