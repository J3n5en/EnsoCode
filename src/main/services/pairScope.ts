import type { HostToPhone, PairedDevice, PairScope, PhoneToHost } from '@enso/pair';

/** 只读设备可用的命令：查看、同步、推送登记与传输层信令；其余（含未来新增）一律视为写操作 */
const READ_SCOPE_COMMANDS: ReadonlySet<string> = new Set([
  'snapshot',
  'subscribe',
  'history',
  'push-subscribe',
  'push-unsubscribe',
  'presence',
  'direct-offer',
  'direct-ice',
  'direct-close',
  'probe',
  'bot-catalog-request',
  'bot-chat-open',
  'bot-timeline',
  'bot-inbox-request',
  'bot-artifacts',
  'bot-artifact-image',
]);

export const deviceScope = (device: Pick<PairedDevice, 'scope'>): PairScope =>
  device.scope === 'read' ? 'read' : 'operate';

export const commandAllowedForScope = (scope: PairScope, type: string): boolean =>
  scope === 'operate' || READ_SCOPE_COMMANDS.has(type);

export const isPairScope = (value: unknown): value is PairScope =>
  value === 'read' || value === 'operate';

/** 作用域拦截的回执：bot-send 要结算手机离线队列，其余让手机提示「此设备为只读」 */
export const scopeRejection = (command: PhoneToHost): HostToPhone =>
  command.type === 'bot-send'
    ? {
        type: 'bot-send-result',
        chatId: command.chatId,
        deliveryId: command.deliveryId,
        ok: false,
        error: 'read-only',
      }
    : { type: 'command-rejected', command: command.type, error: 'read-only' };

export function setScopeInList(
  list: readonly PairedDevice[],
  pairId: string,
  scope: PairScope
): PairedDevice[] {
  return list.map((d) => (d.pairId === pairId ? { ...d, scope } : d));
}
