import type { SecretaryInvokeOp } from '@shared/secretary/tools';
import type { SecretaryProfile } from '@shared/types/secretary';
import { cleanupHandlersFor } from './cleanup';
import { contactSendFileHandlerFor } from './contactSend';
import { toolHandlersFor } from './customTools';
import { createSecretaryDispatchHandlers, dispatchPortsFor } from './dispatch';
import { githubOpsHandlersFor } from './githubOps';
import { imageViewHandlerFor } from './imageView';
import { peerHandlersFor, turnRestriction } from './peers';
import { profileHandlersFor } from './profile';
import { createSecretaryReadHandlers, readPortsFor } from './readers';
import { scheduleHandlersFor } from './schedules';
import { type SecretaryContext, secretaryContext } from './secretaries';
import { skillHandlersFor } from './skills';
import { SecretaryStore } from './store';

export type SecretaryOpResult = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * 调用方由 Main 按 worker 事件身份确定，不从模型参数里取；界面直接发起的写操作为 null。
 * secretaryId 同样只由 Main 按会话权威反推。
 */
export interface SecretaryOpContext {
  secretaryConversationId: string | null;
  secretaryId?: string;
}

export type SecretaryOpHandler = (
  params: Record<string, unknown>,
  ctx: SecretaryOpContext
) => SecretaryOpResult | Promise<SecretaryOpResult>;

type HandlerMap = Record<SecretaryInvokeOp, SecretaryOpHandler>;

/**
 * 一个秘书的全部 op。profile 缺省读它自己的档案；降权回合传收窄后的档案，
 * 读写工具看到的可见项目与接管范围就都是交集。
 */
export function secretaryHandlersFor(
  ctx: SecretaryContext,
  profile?: () => SecretaryProfile | null
): HandlerMap {
  const dispatchPorts = dispatchPortsFor(ctx);
  return {
    ...createSecretaryReadHandlers(readPortsFor(ctx, profile)),
    image_view: imageViewHandlerFor(ctx.dir),
    contact_send_file: contactSendFileHandlerFor(ctx.dir),
    ...cleanupHandlersFor(ctx, profile),
    ...createSecretaryDispatchHandlers(profile ? { ...dispatchPorts, profile } : dispatchPorts),
    ...scheduleHandlersFor(ctx),
    ...githubOpsHandlersFor(ctx, profile),
    ...profileHandlersFor(ctx),
    ...skillHandlersFor(ctx),
    ...toolHandlersFor(ctx),
    ...peerHandlersFor(ctx),
  };
}

/** 不降权时的 op 表按秘书复用：派发 handler 里有跨调用的缓存（清理清单） */
const handlerCache = new Map<string, HandlerMap>();

export function forgetSecretaryHandlers(id: string): void {
  handlerCache.delete(id);
}

function handlersFor(ctx: SecretaryContext, secretaryConversationId: string | null): HandlerMap {
  const allowed = secretaryConversationId ? turnRestriction(ctx.id, secretaryConversationId) : null;
  if (allowed) {
    const narrowed = allowed;
    return secretaryHandlersFor(ctx, () => {
      const own = new SecretaryStore(ctx.dir).profile();
      return own ? narrowed(own) : own;
    });
  }
  let cached = handlerCache.get(ctx.id);
  if (!cached) {
    cached = secretaryHandlersFor(ctx);
    handlerCache.set(ctx.id, cached);
  }
  return cached;
}

export async function invokeSecretaryOp(
  op: SecretaryInvokeOp,
  params: unknown,
  ctx: SecretaryOpContext
): Promise<SecretaryOpResult> {
  if (!params || typeof params !== 'object' || Array.isArray(params))
    return { ok: false, error: 'invalid arguments: arguments must be a JSON object' };
  const secretary = ctx.secretaryId ? secretaryContext(ctx.secretaryId) : null;
  if (!secretary) return { ok: false, error: 'secretary not found' };
  const handler = handlersFor(secretary, ctx.secretaryConversationId)[op];
  if (!handler) return { ok: false, error: `unknown op: ${String(op)}` };
  try {
    return await handler(params as Record<string, unknown>, ctx);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
