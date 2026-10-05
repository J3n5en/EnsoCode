import { describe, expect, it } from 'vitest';
import { draftFromSentText, EMPTY_BOT_DRAFT, readBotDraft, writeBotDraft } from './botDraft';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe('bot composer drafts', () => {
  it('回退回填：把 Main 展开的技能块 / 聊天摘录 / 笔记块还原成草稿引用', () => {
    const sent =
      '<notes-updated>n</notes-updated>\n<skill name="review" location="/s/SKILL.md">\nReferences are relative to /s.\n\nbody\n</skill>\n\n看 @src/a.ts\n\n<chat-reference id="c1" title="A" kind="direct">\nx\n</chat-reference>';
    expect(draftFromSentText(sent)).toEqual({
      text: '看 @src/a.ts',
      files: [],
      chats: ['c1'],
      skill: 'review',
    });
    expect(draftFromSentText('plain')).toEqual({ text: 'plain', files: [], chats: [] });
  });

  it('按聊天分别持久化，读回一致', () => {
    const storage = memoryStorage();
    writeBotDraft(storage, 'a', {
      text: 'hello @src/a.ts',
      files: ['src/a.ts'],
      chats: ['c1'],
      skill: 's',
    });
    writeBotDraft(storage, 'b', { ...EMPTY_BOT_DRAFT, text: 'other' });
    expect(readBotDraft(storage, 'a')).toEqual({
      text: 'hello @src/a.ts',
      files: ['src/a.ts'],
      chats: ['c1'],
      skill: 's',
    });
    expect(readBotDraft(storage, 'b').text).toBe('other');
    expect(readBotDraft(storage, 'missing')).toEqual(EMPTY_BOT_DRAFT);
  });

  it('空草稿删除键', () => {
    const storage = memoryStorage();
    writeBotDraft(storage, 'a', { ...EMPTY_BOT_DRAFT, text: 'x' });
    writeBotDraft(storage, 'a', EMPTY_BOT_DRAFT);
    expect(storage.data.size).toBe(0);
  });

  it('坏数据与脏字段回落为空或被丢弃', () => {
    const storage = memoryStorage();
    storage.data.set('enso-bot-draft:a', '{oops');
    expect(readBotDraft(storage, 'a')).toEqual(EMPTY_BOT_DRAFT);
    storage.data.set(
      'enso-bot-draft:a',
      JSON.stringify({ text: 1, files: ['ok', 2], chats: ['1', '2', '3', '4'], skill: 5 })
    );
    expect(readBotDraft(storage, 'a')).toEqual({ text: '', files: ['ok'], chats: ['1', '2', '3'] });
  });

  it('存储失败（配额满）不抛出', () => {
    const storage = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => writeBotDraft(storage, 'a', { ...EMPTY_BOT_DRAFT, text: 'x' })).not.toThrow();
  });
});
