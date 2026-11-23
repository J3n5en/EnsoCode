export type HomeConversationResult =
  | { ok: true; conversationId: string }
  | { ok: false; error: string };

export interface HomeConversationPorts {
  /** 这个秘书现有的、没归档的会话 */
  existing(): string | null;
  create(): Promise<HomeConversationResult>;
}

/** 配置问题：重试也一样，原因直接交回去 */
const PERMANENT_ERRORS = new Set([
  'no usable model',
  'disabled',
  'secretary not found',
  'not an active secretary project',
]);

const starting = new Map<string, Promise<HomeConversationResult>>();

/**
 * 秘书的会话用到时才建：联系渠道、定时、同事消息先到时由 Main 建，与在电脑上第一次打开一样。
 * 同一个秘书同时来几条只建一条；偶发失败重试一次。
 */
export function ensureHomeConversation(
  secretaryId: string,
  ports: HomeConversationPorts
): Promise<HomeConversationResult> {
  const running = starting.get(secretaryId);
  if (running) return running;
  const run = (async (): Promise<HomeConversationResult> => {
    const existing = ports.existing();
    if (existing) return { ok: true, conversationId: existing };
    const first = await ports.create();
    if (first.ok || PERMANENT_ERRORS.has(first.error)) return first;
    return ports.create();
  })().finally(() => starting.delete(secretaryId));
  starting.set(secretaryId, run);
  return run;
}
