import { describe, expect, it } from 'vitest';
import { ensureHomeConversation, type HomeConversationPorts } from './homeConversation';

function fake(results: ({ ok: true } | { ok: false; error: string })[] = []) {
  const state = { existing: null as string | null, creates: 0 };
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ports: HomeConversationPorts = {
    existing: () => state.existing,
    create: async () => {
      state.creates += 1;
      await gate;
      const result = results.shift() ?? { ok: true };
      if (!result.ok) return result;
      const id = `conv-${state.creates}`;
      state.existing = id;
      return { ok: true, conversationId: id };
    },
  };
  return { ports, state, release };
}

describe('秘书自己的会话：用到时才建', () => {
  it('已有会话直接用，不新建', async () => {
    const h = fake();
    h.state.existing = 'conv-old';
    h.release();
    await expect(ensureHomeConversation('s1', h.ports)).resolves.toEqual({
      ok: true,
      conversationId: 'conv-old',
    });
    expect(h.state.creates).toBe(0);
  });

  it('同一个秘书同时来几条消息：只建一条会话，大家拿到同一个 id', async () => {
    const h = fake();
    const all = Promise.all([
      ensureHomeConversation('s1', h.ports),
      ensureHomeConversation('s1', h.ports),
      ensureHomeConversation('s1', h.ports),
    ]);
    h.release();
    const results = await all;
    expect(h.state.creates).toBe(1);
    expect(results.map((result) => result.ok && result.conversationId)).toEqual([
      'conv-1',
      'conv-1',
      'conv-1',
    ]);
  });

  it('几个秘书同时第一次收到消息：各建各的，互不复用', async () => {
    const a = fake();
    const b = fake();
    const all = Promise.all([
      ensureHomeConversation('s-a', a.ports),
      ensureHomeConversation('s-b', b.ports),
      ensureHomeConversation('s-a', a.ports),
      ensureHomeConversation('s-b', b.ports),
    ]);
    a.release();
    b.release();
    await all;
    expect([a.state.creates, b.state.creates]).toEqual([1, 1]);
  });

  it('偶发失败重试一次', async () => {
    const h = fake([{ ok: false, error: 'spawn failed' }]);
    h.release();
    await expect(ensureHomeConversation('s1', h.ports)).resolves.toEqual({
      ok: true,
      conversationId: 'conv-2',
    });
    expect(h.state.creates).toBe(2);
  });

  it('没配模型这类重试也没用的错误：不重试，原因交回去', async () => {
    const h = fake([{ ok: false, error: 'no usable model' }]);
    h.release();
    await expect(ensureHomeConversation('s1', h.ports)).resolves.toEqual({
      ok: false,
      error: 'no usable model',
    });
    expect(h.state.creates).toBe(1);
  });

  it('默认模型不可用（带模型与原因的报错）同样不重试，原样交回', async () => {
    const error =
      'no usable model: the default model "Magpie / devin/swe-2-1" is unavailable (its provider has no API key). No other model was used. Fix or re-pick it in Settings → Models → Default model.';
    const h = fake([{ ok: false, error }]);
    h.release();
    await expect(ensureHomeConversation('s1', h.ports)).resolves.toEqual({ ok: false, error });
    expect(h.state.creates).toBe(1);
  });
});
