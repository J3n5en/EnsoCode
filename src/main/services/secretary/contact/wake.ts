export interface SecretaryWakePorts {
  alive(conversationId: string): boolean;
  resume(conversationId: string): Promise<{ ok: boolean; error?: string }>;
  prompt(conversationId: string, text: string): { ok: boolean; error?: string };
}

/**
 * 手机发来的话进秘书会话。worker 被闲置回收后 prompt 仍会「投递成功」却被 worker 拒收，
 * 所以不能靠 prompt 失败再恢复：先看 worker 在不在，不在就拉起再投。
 */
export async function deliverToSecretary(
  ports: SecretaryWakePorts,
  conversationId: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  if (!ports.alive(conversationId)) {
    const resumed = await ports.resume(conversationId);
    if (!resumed.ok) return { ok: false, error: resumed.error ?? 'resume-failed' };
  }
  const sent = ports.prompt(conversationId, text);
  return sent.ok ? { ok: true } : { ok: false, error: sent.error ?? 'prompt-failed' };
}
