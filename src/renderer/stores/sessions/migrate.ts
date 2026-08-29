/**
 * sessions 持久化数据的版本迁移。
 *
 * 为什么用 zustand persist 的 `migrate` 而不是 `onRehydrateStorage`（对齐 settings/migrate.ts）：
 * `migrate` 只在持久版本落后时跑一次，跑完 persist 会把结果写回磁盘，旧字段就此消失；
 * `onRehydrateStorage` 每次 rehydrate 都会执行且不触发回写，等于把一次性的形状迁移
 * 变成永久的读侧补丁——且就地 mutate 不经过 setState，订阅方收不到变更。
 */

/** 当前持久化数据版本；改数据形状时 +1 并在 `migrateSessions` 里加一段 */
export const SESSIONS_VERSION = 1;

/**
 * v0 → v1：started 是运行态，历史版本误将其持久化，导致重启后 ChatView 的
 * `!started` 自动恢复门永假（会话点开空白、无报错、不重试）。一律清 false；
 * 无 sessionFile 的已启动会话重启后无从回放，落终态并带错误文案。
 */
export function migrateSessions(persisted: unknown, version: number): unknown {
  if (version >= SESSIONS_VERSION) return persisted;
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) return persisted;

  const state = { ...(persisted as Record<string, unknown>) };
  const conversations = state.conversations;
  if (!conversations || typeof conversations !== 'object' || Array.isArray(conversations)) {
    return state;
  }

  state.conversations = Object.fromEntries(
    Object.entries(conversations as Record<string, unknown>).map(([id, entry]) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [id, entry];
      const conversation = entry as Record<string, unknown>;
      const orphaned = conversation.started === true && !conversation.sessionFile;
      return [
        id,
        {
          ...conversation,
          started: false,
          ...(orphaned
            ? { status: 'failed', error: 'Session ended — history not restored' }
            : { status: 'idle' }),
        },
      ];
    })
  );
  return state;
}
