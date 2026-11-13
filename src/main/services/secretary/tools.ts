import type { SecretaryOp } from '@shared/secretary/tools';

export type SecretaryOpResult = { ok: true; result: unknown } | { ok: false; error: string };

export type SecretaryOpHandler = (
  params: Record<string, unknown>
) => SecretaryOpResult | Promise<SecretaryOpResult>;

/** 业务逻辑按单元逐个落地；未实现的 op 一律回 unavailable，让模型转告用户而不是重试 */
const unavailable: SecretaryOpHandler = () => ({ ok: false, error: 'unavailable' });

export const SECRETARY_OP_HANDLERS: Record<SecretaryOp, SecretaryOpHandler> = {
  project_list: unavailable,
  project_info: unavailable,
  session_list: unavailable,
  session_read: unavailable,
  session_create: unavailable,
  session_send: unavailable,
  session_stop: unavailable,
  todo_item_add: unavailable,
  todo_item_update: unavailable,
  todo_item_dispatch: unavailable,
  schedule_add: unavailable,
  schedule_list: unavailable,
  schedule_remove: unavailable,
  secretary_profile_propose: unavailable,
};

export async function invokeSecretaryOp(
  op: SecretaryOp,
  params: unknown
): Promise<SecretaryOpResult> {
  if (!params || typeof params !== 'object' || Array.isArray(params))
    return { ok: false, error: 'invalid arguments' };
  const handler = SECRETARY_OP_HANDLERS[op];
  if (!handler) return { ok: false, error: `unknown op: ${String(op)}` };
  try {
    return await handler(params as Record<string, unknown>);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
