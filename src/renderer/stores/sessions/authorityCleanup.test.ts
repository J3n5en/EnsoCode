import { describe, expect, it, vi } from 'vitest';
import { type ConversationAuthorityPort, purgeConversationAuthority } from './authorityCleanup';

const conversation = (lifecycle: 'draft' | 'ready' | 'ended', version: number) =>
  ({ conversationId: 'c1', lifecycle, version }) as never;

const makePort = (
  lifecycle: 'draft' | 'ready' | 'ended',
  version: number
): ConversationAuthorityPort & {
  endConversation: ReturnType<typeof vi.fn>;
  removeConversation: ReturnType<typeof vi.fn>;
} => ({
  read: vi.fn(async () => ({ conversations: [conversation(lifecycle, version)] })),
  endConversation: vi.fn(async (request: { version: number }) => ({
    accepted: true,
    value: conversation('ended', request.version + 1) as never,
  })),
  removeConversation: vi.fn(async () => ({ accepted: true })),
});

const ids = () => {
  let n = 0;
  return () => `req-${++n}`;
};

describe('purgeConversationAuthority', () => {
  it('活跃会话先 end 再按新 version remove', async () => {
    const port = makePort('ready', 3);
    await expect(purgeConversationAuthority(port, 'c1', ids())).resolves.toBe(true);

    expect(port.endConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c1', version: 3 })
    );
    expect(port.removeConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c1', version: 4 })
    );
  });

  it('已 ended 的孤儿注册项跳过 end，直接 remove（否则 jsonl 永远删不掉）', async () => {
    const port = makePort('ended', 7);
    await expect(purgeConversationAuthority(port, 'c1', ids())).resolves.toBe(true);

    expect(port.endConversation).not.toHaveBeenCalled();
    expect(port.removeConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c1', version: 7 })
    );
  });

  it('注册项不存在时不做任何变更', async () => {
    const port = makePort('ready', 1);
    port.read = vi.fn(async () => ({ conversations: [] }));
    await expect(purgeConversationAuthority(port, 'c1', ids())).resolves.toBe(false);
    expect(port.endConversation).not.toHaveBeenCalled();
    expect(port.removeConversation).not.toHaveBeenCalled();
  });

  it('end 被拒时不继续 remove', async () => {
    const port = makePort('ready', 3);
    port.endConversation = vi.fn(async () => ({ accepted: false }));
    await expect(purgeConversationAuthority(port, 'c1', ids())).resolves.toBe(false);
    expect(port.removeConversation).not.toHaveBeenCalled();
  });
});
