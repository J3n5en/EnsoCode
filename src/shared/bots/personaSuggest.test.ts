import { describe, expect, it } from 'vitest';
import { parsePersonaSuggestion, personaSuggestPrompt } from './personaSuggest';

const input = {
  name: '阿运',
  title: '运维工程师',
  scope: '',
  persona: '',
  language: 'zh' as const,
};

describe('personaSuggestPrompt', () => {
  it('写入名称与角色，转义标签，按语言要求输出', () => {
    const { systemPrompt, userText } = personaSuggestPrompt({ ...input, title: '<b>运维</b>' });
    expect(userText).toContain('name: 阿运');
    expect(userText).toContain('&lt;b&gt;运维&lt;/b&gt;');
    expect(systemPrompt).toContain('Simplified Chinese');
  });
  it('职责已填时只要人设，不再要 scope', () => {
    expect(personaSuggestPrompt(input).systemPrompt).toContain('"scope"');
    expect(personaSuggestPrompt({ ...input, scope: '部署' }).systemPrompt).not.toContain('"scope"');
  });
});

describe('parsePersonaSuggestion', () => {
  it('解析 JSON（允许外层废话与代码围栏）并裁剪空白', () => {
    expect(
      parsePersonaSuggestion(
        '好的：\n```json\n{"persona":"  你是阿运。 ","scope":" 部署与监控 "}\n```',
        input
      )
    ).toEqual({ persona: '你是阿运。', scope: '部署与监控' });
  });
  it('职责已填时丢弃模型给的 scope', () => {
    expect(parsePersonaSuggestion('{"persona":"p","scope":"s"}', { ...input, scope: 'x' })).toEqual(
      {
        persona: 'p',
      }
    );
  });
  it('缺人设、类型不对或不是 JSON 时返回 null', () => {
    expect(parsePersonaSuggestion('{"scope":"s"}', input)).toBeNull();
    expect(parsePersonaSuggestion('{"persona":3}', input)).toBeNull();
    expect(parsePersonaSuggestion('{"persona":"   "}', input)).toBeNull();
    expect(parsePersonaSuggestion('no json', input)).toBeNull();
  });
  it('超长内容截断', () => {
    const r = parsePersonaSuggestion(
      JSON.stringify({ persona: 'a'.repeat(9000), scope: 'b'.repeat(900) }),
      input
    );
    expect(r?.persona.length).toBe(4000);
    expect(r?.scope?.length).toBe(300);
  });
});
