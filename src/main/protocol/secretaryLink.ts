/**
 * enso://secretary?conversation=<id>：手机上的里程碑消息带这个链接，
 * 点开回到应用并选中那个会话。macOS 走 open-url，Windows/Linux 走 argv。
 */
export function secretaryConversationFromLink(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith('enso://')) return null;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== 'secretary') return null;
    const conversationId = url.searchParams.get('conversation')?.trim() ?? '';
    return conversationId || null;
  } catch {
    return null;
  }
}

export function createSecretaryLinkInbox(platform: NodeJS.Platform) {
  const queued: string[] = [];
  let deliver: ((conversationId: string) => void) | null = null;

  const push = (raw: string | null) => {
    const conversationId = raw ? secretaryConversationFromLink(raw) : null;
    if (!conversationId || queued.includes(conversationId)) return;
    if (deliver) deliver(conversationId);
    else queued.push(conversationId);
  };

  return {
    noteLink(raw: string) {
      push(raw);
    },
    noteArgv(argv: readonly string[]) {
      if (platform === 'darwin') return;
      for (const arg of argv) push(arg);
    },
    start(send: (conversationId: string) => void) {
      deliver = send;
      const pending = queued.splice(0);
      for (const conversationId of pending) send(conversationId);
    },
  };
}
