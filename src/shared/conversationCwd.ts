const CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 会话工作目录。scratch 固定为 `<根>/<会话 id>`，并拒绝非法 id；
 * secretary 固定为项目根（秘书不读写代码，也没有 worktree）。renderer 也引用，不能依赖 node:path。
 */
export function conversationCwd(input: {
  kind?: string;
  canonicalPath: string;
  conversationId: string;
  worktreePath?: string;
}): string | null {
  if (input.kind === 'scratch') {
    if (!input.canonicalPath || !CONVERSATION_ID.test(input.conversationId)) return null;
    const sep = input.canonicalPath.includes('/') ? '/' : '\\';
    return `${input.canonicalPath.replace(/[\\/]+$/, '')}${sep}${input.conversationId}`;
  }
  if (input.kind === 'secretary') return input.canonicalPath || null;
  if (input.kind === 'ssh') return input.canonicalPath || null;
  if (input.worktreePath) return input.worktreePath;
  return input.canonicalPath || null;
}
