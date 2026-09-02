import type { PhoneToHost } from '@enso/pair';
import { type CommandCheck, parsePhoneCommand } from './pairPolicy';

/**
 * 渲染层经 NODES_SEND 发给远程节点的命令校验。
 * 结构校验复用手机白名单（对端 host 也是按它收），再收窄掉桌面不该发的：
 * Web Push 登记——桌面没有 pushManager，且不该往对方机器塞推送订阅。
 */
const GUEST_DENIED: ReadonlySet<PhoneToHost['type']> = new Set([
  'push-subscribe',
  'push-unsubscribe',
]);

export function parseGuestOutbound(value: unknown): CommandCheck {
  const parsed = parsePhoneCommand(value);
  if (!parsed.ok) return parsed;
  if (GUEST_DENIED.has(parsed.command.type)) {
    return { ok: false, error: `command not allowed from desktop guest: ${parsed.command.type}` };
  }
  return parsed;
}
