import { describe, expect, it } from 'vitest';
import {
  evictColdMessages,
  isBulkyAgentEvent,
  isMessageCacheHot,
  MESSAGE_CACHE_TTL_MS,
  viewedConversationId,
} from './messageCache';

describe('messageCache', () => {
  it('viewed id prefers an existing tab over the parent', () => {
    expect(viewedConversationId('parent', 'child', (id) => id === 'child')).toBe('child');
    expect(viewedConversationId('parent', 'missing', (id) => id === 'parent')).toBe('parent');
    expect(viewedConversationId(null, undefined, () => false)).toBeNull();
  });

  it('current viewed session is always hot', () => {
    expect(isMessageCacheHot('a', 'a', {}, 1000)).toBe(true);
    expect(isMessageCacheHot('b', 'a', {}, 1000)).toBe(false);
  });

  it('recently viewed stays hot until TTL', () => {
    const last = { b: 1000 };
    expect(isMessageCacheHot('b', 'a', last, 1000 + MESSAGE_CACHE_TTL_MS - 1)).toBe(true);
    expect(isMessageCacheHot('b', 'a', last, 1000 + MESSAGE_CACHE_TTL_MS)).toBe(false);
  });

  it('evicts stale message bodies, leaves hot and empty conversations', () => {
    const conversations = {
      hot: { messages: [1], customEntries: [2] },
      stale: { messages: [3], customEntries: [4] },
      empty: { messages: [], customEntries: [] },
    };
    const next = evictColdMessages(conversations, 'hot', { stale: 0 }, MESSAGE_CACHE_TTL_MS);
    expect(next.hot).toBe(conversations.hot);
    expect(next.stale).toEqual({ messages: [], customEntries: [] });
    expect(next.empty).toBe(conversations.empty);
  });

  it('message-upsert and custom entries are bulky', () => {
    expect(isBulkyAgentEvent('message-upsert')).toBe(true);
    expect(isBulkyAgentEvent('session-custom-entry')).toBe(true);
    expect(isBulkyAgentEvent('status')).toBe(false);
  });
});

describe('hasAuthoritativeMessages', () => {
  it('optimistic-only timeline still needs a snapshot', async () => {
    const { hasAuthoritativeMessages } = await import('./messageCache');
    expect(hasAuthoritativeMessages([])).toBe(false);
    expect(hasAuthoritativeMessages([{ optimistic: true }])).toBe(false);
    expect(hasAuthoritativeMessages([{}, { optimistic: true }])).toBe(true);
  });
});
