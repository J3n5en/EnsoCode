import { describe, expect, it } from 'vitest';
import type { SecretaryCard, SecretaryState } from '../types/secretary';
import { secretaryOwner, takeoverOf } from './origin';

const stateOf = (
  id: string,
  cards: SecretaryCard[] = [],
  takeovers: SecretaryState['takeovers'] = []
): SecretaryState => ({
  secretaryId: id,
  enabled: true,
  projectId: `p-${id}`,
  profile: null,
  persona: '',
  board: { needsYou: [], running: cards, done: [], todos: [] },
  proposals: {},
  takeovers,
});

const card = (conversationId: string, column: 'running' | 'needsYou' | 'done' = 'running') =>
  ({
    kind: 'session',
    conversationId,
    projectId: 'p1',
    projectName: 'enso',
    title: conversationId,
    state: 'running',
    startedAt: 1,
    stateSince: 1,
    secretaryConversationId: `sec-${conversationId}`,
    ...(column === 'needsYou' ? { result: 'failed' as const } : {}),
  }) satisfies SecretaryCard;

describe('secretaryOwner', () => {
  const states = {
    default: stateOf('default', [card('c-ai')]),
    's-ken': stateOf('s-ken', [card('c-ken')]),
  };

  it('会话行上的 secretaryId 直接决定归属，不看看板', () => {
    expect(
      secretaryOwner(states, 'c-ken', { secretaryConversationId: 'sec', secretaryId: 's-ken' })
    ).toEqual({
      secretaryId: 's-ken',
    });
  });

  it('老会话没有 secretaryId：按各秘书看板里的派发卡片回退，后到的另一份状态盖不掉它', () => {
    // 推送顺序任意：Ken 的更新先到、爱酱的后到，归属都不变
    expect(
      secretaryOwner({ 's-ken': states['s-ken'] }, 'c-ken', { secretaryConversationId: 'sec' })
    ).toEqual({
      secretaryId: 's-ken',
      secretaryConversationId: 'sec-c-ken',
    });
    expect(secretaryOwner(states, 'c-ai', { secretaryConversationId: 'sec' })).toEqual({
      secretaryId: 'default',
      secretaryConversationId: 'sec-c-ai',
    });
    expect(secretaryOwner(states, 'c-ken', { secretaryConversationId: 'sec' })).toEqual({
      secretaryId: 's-ken',
      secretaryConversationId: 'sec-c-ken',
    });
  });

  it('卡片在需要你处理或完成列里同样认得出', () => {
    const moved = {
      default: {
        ...states.default,
        board: { needsYou: [card('c-ai', 'needsYou')], running: [], done: [], todos: [] },
      },
    };
    expect(secretaryOwner(moved, 'c-ai')?.secretaryId).toBe('default');
  });

  it('谁的看板都没有这个会话时返回 null，不拿别的秘书凑', () => {
    expect(secretaryOwner(states, 'c-other')).toBeNull();
  });

  it('接管的会话归接管它的那个秘书', () => {
    const withTakeover = {
      ...states,
      's-ken': stateOf(
        's-ken',
        [],
        [
          {
            conversationId: 'c-taken',
            projectId: 'p1',
            projectName: 'enso',
            title: 'taken',
            grantedAt: 1,
            via: 'user',
            secretaryConversationId: 'sec-ken',
          },
        ]
      ),
    };
    expect(secretaryOwner(withTakeover, 'c-taken')).toEqual({ secretaryId: 's-ken' });
    expect(takeoverOf(withTakeover, 'c-taken')?.secretaryId).toBe('s-ken');
    expect(takeoverOf(withTakeover, 'c-ai')).toBeNull();
  });
});
