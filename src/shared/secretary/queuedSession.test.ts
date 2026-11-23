import { describe, expect, it } from 'vitest';
import { queuedStartOf, queuePositions } from './queuedSession';

const row = (id: string, queuedStart: unknown, secretaryId?: string) => ({
  id,
  ...(queuedStart === undefined ? {} : { queuedStart }),
  secretaryOrigin: {
    secretaryConversationId: 's',
    ...(secretaryId ? { secretaryId } : {}),
  },
});

describe('queuedStartOf', () => {
  it('只认形状完整的待发送首条消息', () => {
    expect(queuedStartOf(row('a', { queuedAt: 1, text: 'hi' }))).toEqual({
      queuedAt: 1,
      text: 'hi',
    });
    expect(queuedStartOf(row('a', { queuedAt: 1 }))).toBeUndefined();
    expect(queuedStartOf(row('a', 'x'))).toBeUndefined();
    expect(queuedStartOf(undefined)).toBeUndefined();
  });

  it('丢掉坏字段，保留合法的可选字段', () => {
    expect(
      queuedStartOf(
        row('a', {
          queuedAt: 2,
          text: 't',
          goal: 'g',
          attachments: ['/a.png', 3],
          askRelay: { name: 'Mia' },
          failed: { at: 5, error: 'boom' },
          startingAt: 'bad',
        })
      )
    ).toEqual({
      queuedAt: 2,
      text: 't',
      goal: 'g',
      attachments: ['/a.png'],
      askRelay: { name: 'Mia' },
      failed: { at: 5, error: 'boom' },
    });
  });
});

describe('queuePositions', () => {
  it('同一秘书内按排队时间先进先出，id 兜底，失败的不占位', () => {
    const rows = {
      c: row('c', { queuedAt: 3, text: 'c' }),
      b: row('b', { queuedAt: 1, text: 'b' }),
      a: row('a', { queuedAt: 1, text: 'a' }),
      f: row('f', { queuedAt: 0, text: 'f', failed: { at: 1, error: 'x' } }),
      n: row('n', undefined),
    };
    const positions = queuePositions(rows);
    expect(Object.fromEntries(positions)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('不同秘书各排各的', () => {
    const rows = {
      a: row('a', { queuedAt: 1, text: 'a' }, 'one'),
      b: row('b', { queuedAt: 2, text: 'b' }, 'two'),
      c: row('c', { queuedAt: 3, text: 'c' }, 'one'),
    };
    expect(Object.fromEntries(queuePositions(rows))).toEqual({ a: 1, c: 2, b: 1 });
  });
});
