/** 子会话（coworker / child）静音跟随根会话。 */
export function sessionMuteRootId(sessionId: string): string {
  const sep = sessionId.indexOf('::');
  return sep === -1 ? sessionId : sessionId.slice(0, sep);
}

function conversationsOf(
  settings: unknown
): Record<string, { muted?: unknown } | undefined> | undefined {
  if (!settings || typeof settings !== 'object') return undefined;
  const store = (settings as Record<string, unknown>)['enso-conversations'];
  if (!store || typeof store !== 'object') return undefined;
  const state = (store as Record<string, unknown>).state;
  if (!state || typeof state !== 'object') return undefined;
  const conversations = (state as Record<string, unknown>).conversations;
  if (!conversations || typeof conversations !== 'object' || Array.isArray(conversations)) {
    return undefined;
  }
  return conversations as Record<string, { muted?: unknown } | undefined>;
}

/** 持久化的 enso-conversations 里，根会话 muted === true 才算静音。 */
export function isSessionMutedInStore(settings: unknown, sessionId: string): boolean {
  if (!sessionId) return false;
  const conversations = conversationsOf(settings);
  if (!conversations) return false;
  const root = sessionMuteRootId(sessionId);
  return conversations[root]?.muted === true;
}
