import { describe, expect, it } from 'vitest';
import { goalSuggestPrompt, parseGoalSuggestion } from './goalSuggest';

const input = {
  goal: '每周帮我整理 <竞品> 动态',
  language: 'zh' as const,
  templates: [
    { id: 'software', title: '软件开发小队', summary: '项目经理带前端、后端、测试' },
    { id: 'research', title: '调研小组', summary: '检索、分析、汇总' },
  ],
};

describe('goalSuggestPrompt', () => {
  it('写入目标与模板清单，转义标签，按语言要求输出', () => {
    const { systemPrompt, userText } = goalSuggestPrompt(input);
    expect(userText).toContain('&lt;竞品&gt;');
    expect(userText).toContain('software: 软件开发小队 — 项目经理带前端、后端、测试');
    expect(systemPrompt).toContain('Simplified Chinese');
    expect(systemPrompt).toContain('"kind"');
  });
  it('没有模板时只允许推荐单个成员', () => {
    const { systemPrompt, userText } = goalSuggestPrompt({ ...input, templates: [] });
    expect(systemPrompt).not.toContain('"templateId"');
    expect(userText).not.toContain('<templates>');
  });
});

describe('parseGoalSuggestion', () => {
  it('解析单成员推荐（允许外层废话与代码围栏），裁剪空白', () => {
    expect(
      parseGoalSuggestion(
        '好的\n```json\n{"kind":"member","member":{"name":" 小研 ","title":" 竞品分析师 ","scope":" 跟踪竞品 ","persona":" 你是小研。 "},"reason":" 单一职责 ","firstMessage":" 请先列出要跟踪的竞品 "}\n```',
        input
      )
    ).toEqual({
      kind: 'member',
      member: { name: '小研', title: '竞品分析师', scope: '跟踪竞品', persona: '你是小研。' },
      reason: '单一职责',
      firstMessage: '请先列出要跟踪的竞品',
    });
  });
  it('成员名去掉空格与非法字符并限长；清理后为空则无效', () => {
    const parsed = parseGoalSuggestion(
      '{"kind":"member","member":{"name":"Ada Lovelace!!! The Great Analyst","title":"t"},"firstMessage":"hi"}',
      input
    );
    expect(parsed?.kind === 'member' && parsed.member.name).toBe('AdaLovelaceTheGreatAnaly');
    expect(
      parseGoalSuggestion(
        '{"kind":"member","member":{"name":"!!!","title":"t"},"firstMessage":"hi"}',
        input
      )
    ).toBeNull();
  });
  it('解析团队推荐，模板 id 必须在清单内', () => {
    expect(
      parseGoalSuggestion(
        '{"kind":"team","templateId":"research","reason":"多角色","firstMessage":"开始调研"}',
        input
      )
    ).toEqual({ kind: 'team', templateId: 'research', reason: '多角色', firstMessage: '开始调研' });
    expect(
      parseGoalSuggestion('{"kind":"team","templateId":"legal","firstMessage":"x"}', input)
    ).toBeNull();
  });
  it('缺第一条消息时回落为用户目标原文', () => {
    const parsed = parseGoalSuggestion('{"kind":"team","templateId":"software"}', input);
    expect(parsed?.firstMessage).toBe(input.goal);
  });
  it('坏输入返回 null', () => {
    for (const text of [
      '',
      'no json',
      '{bad',
      '[]',
      '{"kind":"group"}',
      '{"kind":"member","member":{"name":"a"}}',
      '{"kind":"member","member":"a"}',
    ])
      expect(parseGoalSuggestion(text, input), text).toBeNull();
  });
});
