import { describe, expect, it } from 'vitest';
import { latestSecretaryConversation } from './secretaryEntry';

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
  it('取该秘书项目下最近活跃且未归档的会话', () => {
    expect(latestSecretaryConversation('sec', directory)).toBe('new');
  });

  it('未设置项目或没有会话时返回 null', () => {
    expect(latestSecretaryConversation(null, directory)).toBeNull();
    expect(latestSecretaryConversation('missing', directory)).toBeNull();
  });
});
