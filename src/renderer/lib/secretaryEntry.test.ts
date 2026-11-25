import { describe, expect, it } from 'vitest';
import {
  latestSecretaryConversation,
  secretaryConversationIds,
  secretaryUnreadCount,
} from './secretaryEntry';

const directory = {
  order: ['old', 'new', 'archived', 'other'],
  conversations: {
    old: { projectId: 'sec', lastActiveAt: 100, messages: [] },
    new: { projectId: 'sec', lastActiveAt: 300, messages: [] },
    archived: { projectId: 'sec', lastActiveAt: 900, archived: true, messages: [] },
    other: { projectId: 'p1', lastActiveAt: 999, messages: [] },
  },
};

describe('latestSecretaryConversation', () => {
  it('未读数只数该秘书侧栏列表里的会话（不含归档、子会话与别的项目）', () => {
    const conversations = {
      a: { projectId: 'sec', createdAt: 1, unread: true, messages: [] },
      b: { projectId: 'sec', createdAt: 2, messages: [] },
      archived: { projectId: 'sec', createdAt: 3, unread: true, archived: true, messages: [] },
      child: { projectId: 'sec', createdAt: 4, unread: true, parentId: 'a', messages: [] },
      other: { projectId: 'p1', createdAt: 5, unread: true, messages: [] },
      c: { projectId: 'sec', createdAt: 6, unread: true, messages: [] },
    };
    const order = Object.keys(conversations);
    expect(secretaryUnreadCount('sec', order, conversations)).toBe(2);
    expect(secretaryUnreadCount(null, order, conversations)).toBe(0);
  });

  it('取该秘书项目下最近活跃且未归档的会话', () => {
    expect(latestSecretaryConversation('sec', directory)).toBe('new');
  });

  it('未设置项目或没有会话时返回 null', () => {
    expect(latestSecretaryConversation(null, directory)).toBeNull();
    expect(latestSecretaryConversation('missing', directory)).toBeNull();
  });
});

describe('secretaryConversationIds', () => {
  const sidebar = {
    order: ['used', 'child', 'archived', 'other', 'pinned', 'fresh'],
    conversations: {
      used: { projectId: 'sec', createdAt: 100, lastActiveAt: 500, messages: [] },
      child: { projectId: 'sec', createdAt: 900, parentId: 'used', messages: [] },
      archived: { projectId: 'sec', createdAt: 900, archived: true, messages: [] },
      other: { projectId: 'p1', createdAt: 900, messages: [] },
      pinned: { projectId: 'sec', createdAt: 10, lastActiveAt: 20, pinned: true, messages: [] },
      // 刚新建、尚无消息：侧栏投影里没有 lastActiveAt，只能回落 createdAt
      fresh: { projectId: 'sec', createdAt: 800, messages: [] },
    },
  };

  it('新建的空会话按 createdAt 排在非置顶会话最前，与普通项目一致', () => {
    expect(secretaryConversationIds('sec', sidebar.order, sidebar.conversations)).toEqual([
      'pinned',
      'fresh',
      'used',
    ]);
  });

  it('未设置秘书项目时为空', () => {
    expect(secretaryConversationIds(null, sidebar.order, sidebar.conversations)).toEqual([]);
  });
});
