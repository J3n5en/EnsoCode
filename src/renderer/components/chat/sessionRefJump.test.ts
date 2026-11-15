import { describe, expect, it } from 'vitest';
import { conversationIdBySessionFile } from './sessionRefJump';

describe('conversationIdBySessionFile', () => {
  const conversations = {
    a: { sessionFile: '/sessions/a.jsonl' },
    b: { sessionFile: '/sessions/b.jsonl' },
    c: {},
  };

  it('按 sessionFile 找到会话 id', () => {
    expect(conversationIdBySessionFile(conversations, '/sessions/b.jsonl')).toBe('b');
  });

  it('找不到或没有 sessionFile 时返回 null，卡片保持不可点', () => {
    expect(conversationIdBySessionFile(conversations, '/sessions/gone.jsonl')).toBeNull();
    expect(conversationIdBySessionFile(conversations, '')).toBeNull();
    expect(conversationIdBySessionFile({}, '/sessions/a.jsonl')).toBeNull();
  });
});
