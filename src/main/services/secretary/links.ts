/**
 * 回到应用的入口：手机上点「在应用里打开」时用。
 * 由 Main 装配时注入，ipc 层不直接碰 Electron（server 入口也走这条依赖图）。
 */
export interface SecretaryOpenTarget {
  conversationId?: string;
  proposalId?: string;
}

let handler: ((target: SecretaryOpenTarget) => void) | null = null;

export function setSecretaryOpenTarget(next: ((target: SecretaryOpenTarget) => void) | null): void {
  handler = next;
}

export function openSecretaryTarget(target: SecretaryOpenTarget): void {
  handler?.(target);
}
