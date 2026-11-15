/**
 * enso://secretary?conversation=<id>[&proposal=<id>]：手机上的里程碑与确认卡消息带这个链接，
 * 点开回到应用并选中那个会话；带 proposal 时再把工作台滚到那张卡。
 * macOS 走 open-url，Windows/Linux 走 argv。
 */
export interface SecretaryLinkTarget {
  conversationId: string;
  proposalId?: string;
}

export function secretaryTargetFromLink(raw: string): SecretaryLinkTarget | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith('enso://')) return null;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== 'secretary') return null;
    const conversationId = url.searchParams.get('conversation')?.trim() ?? '';
    if (!conversationId) return null;
    const proposalId = url.searchParams.get('proposal')?.trim() ?? '';
    return { conversationId, ...(proposalId ? { proposalId } : {}) };
  } catch {
    return null;
  }
}

export function createSecretaryLinkInbox(platform: NodeJS.Platform) {
  const queued: SecretaryLinkTarget[] = [];
  let deliver: ((target: SecretaryLinkTarget) => void) | null = null;

  const push = (raw: string | null) => {
    const target = raw ? secretaryTargetFromLink(raw) : null;
    if (!target) return;
    if (queued.some((entry) => entry.conversationId === target.conversationId)) return;
    if (deliver) deliver(target);
    else queued.push(target);
  };

  return {
    noteLink(raw: string) {
      push(raw);
    },
    noteArgv(argv: readonly string[]) {
      if (platform === 'darwin') return;
      for (const arg of argv) push(arg);
    },
    start(send: (target: SecretaryLinkTarget) => void) {
      deliver = send;
      const pending = queued.splice(0);
      for (const target of pending) send(target);
    },
  };
}
