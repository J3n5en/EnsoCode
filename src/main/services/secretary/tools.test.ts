import { describe, expect, it } from 'vitest';
import { invokeSecretaryOp, SECRETARY_OP_HANDLERS } from './tools';

describe('invokeSecretaryOp', () => {
  it('把调用方秘书会话传给处理函数', async () => {
    const original = SECRETARY_OP_HANDLERS.project_list;
    let seen: unknown;
    SECRETARY_OP_HANDLERS.project_list = (_params, ctx) => {
      seen = ctx;
      return { ok: true, result: [] };
    };
    try {
      await invokeSecretaryOp('project_list', {}, { secretaryConversationId: 'sec-1' });
    } finally {
      SECRETARY_OP_HANDLERS.project_list = original;
    }
    expect(seen).toEqual({ secretaryConversationId: 'sec-1' });
  });

  it('参数不是对象时拒绝', async () => {
    expect(
      await invokeSecretaryOp('project_list', [], { secretaryConversationId: 'sec-1' })
    ).toEqual({ ok: false, error: 'invalid arguments: arguments must be a JSON object' });
  });
});
