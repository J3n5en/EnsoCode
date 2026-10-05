import { describe, expect, it } from 'vitest';
import { wrapInterjection } from './interject';
import { stripBotNotesUpdate } from './notes';

describe('stripBotNotesUpdate', () => {
  it('只去掉开头的笔记更新块', () => {
    expect(stripBotNotesUpdate('<notes-updated>\n- a\n</notes-updated>\n\nhello')).toBe('hello');
    expect(
      stripBotNotesUpdate('  <notes-updated>x</notes-updated><routine title="t">p</routine>')
    ).toBe('<routine title="t">p</routine>');
    expect(stripBotNotesUpdate('hello <notes-updated>x</notes-updated>')).toBe(
      'hello <notes-updated>x</notes-updated>'
    );
    expect(stripBotNotesUpdate('<notes-updated>unterminated')).toBe('<notes-updated>unterminated');
  });

  it('笔记块之后的插话补充说明一并去掉', () => {
    expect(
      stripBotNotesUpdate(`<notes-updated>x</notes-updated>\n\n${wrapInterjection('hi', 'zh')}`)
    ).toBe('hi');
    expect(stripBotNotesUpdate(wrapInterjection('hi', 'en'))).toBe('hi');
  });
});
