import { describe, expect, it } from 'vitest';
import { remapConversationProjectIds } from './projectAuthorityRemap';

describe('remapConversationProjectIds', () => {
  it('moves remapped roots and their children onto the keeper project', () => {
    const conversations = {
      root: { projectId: 'dup', title: 'root' },
      child: { projectId: 'dup', parentId: 'root', title: 'child' },
      other: { projectId: 'keep', title: 'other' },
    };
    const next = remapConversationProjectIds(conversations, [
      { conversationId: 'root', projectId: 'keep' },
    ]);
    expect(next).toEqual({
      root: { projectId: 'keep', title: 'root' },
      child: { projectId: 'keep', parentId: 'root', title: 'child' },
      other: { projectId: 'keep', title: 'other' },
    });
  });

  it('returns the same object when nothing remaps', () => {
    const conversations = { root: { projectId: 'keep' } };
    expect(
      remapConversationProjectIds(conversations, [{ conversationId: 'root', projectId: 'keep' }])
    ).toBe(conversations);
  });
});
