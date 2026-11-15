import type { SecretaryInvokeOp } from '@shared/secretary/tools';
import { secretaryCleanupHandlers } from './cleanup';
import { secretaryToolHandlers } from './customTools';
import { secretaryDispatchHandlers } from './dispatch';
import { secretaryImageViewHandler } from './imageView';
import { secretaryProfileHandlers } from './profile';
import { secretaryReadHandlers } from './readers';
import { secretaryScheduleHandlers } from './schedules';
import { secretarySkillHandlers } from './skills';

export type SecretaryOpResult = { ok: true; result: unknown } | { ok: false; error: string };

/** 调用方由 Main 按 worker 事件身份确定，不从模型参数里取；界面直接发起的写操作为 null */
export interface SecretaryOpContext {
  secretaryConversationId: string | null;
}

export type SecretaryOpHandler = (
  params: Record<string, unknown>,
  ctx: SecretaryOpContext
) => SecretaryOpResult | Promise<SecretaryOpResult>;

export const SECRETARY_OP_HANDLERS: Record<SecretaryInvokeOp, SecretaryOpHandler> = {
  ...secretaryReadHandlers,
  image_view: secretaryImageViewHandler,
  ...secretaryCleanupHandlers,
  ...secretaryDispatchHandlers,
  ...secretaryScheduleHandlers,
  ...secretaryProfileHandlers,
  ...secretarySkillHandlers,
  ...secretaryToolHandlers,
};

export async function invokeSecretaryOp(
  op: SecretaryInvokeOp,
  params: unknown,
  ctx: SecretaryOpContext
): Promise<SecretaryOpResult> {
  if (!params || typeof params !== 'object' || Array.isArray(params))
    return { ok: false, error: 'invalid arguments: arguments must be a JSON object' };
  const handler = SECRETARY_OP_HANDLERS[op];
  if (!handler) return { ok: false, error: `unknown op: ${String(op)}` };
  try {
    return await handler(params as Record<string, unknown>, ctx);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
