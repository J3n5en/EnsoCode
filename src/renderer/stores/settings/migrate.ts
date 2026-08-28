/**
 * 持久化数据的版本迁移。
 *
 * 为什么用 zustand persist 的 `migrate` 而不是 `onRehydrateStorage`：
 * `migrate` 只在持久版本落后时跑一次，跑完 persist 会把结果写回磁盘，旧字段就此消失；
 * `onRehydrateStorage` 每次 rehydrate（含多窗口同步广播）都会执行，且不触发回写，
 * 等于把一次性的形状迁移变成永久的读侧补丁。
 */

/** 当前持久化数据版本；改数据形状时 +1 并在 `migrateSettings` 里加一段 */
export const SETTINGS_VERSION = 2;

/**
 * v0 → v1：`ModelProvider.oauthProviderId` 改名为 `oauthAccountKey`。
 * v1 → v2：新增必填 `defaultModel`，旧设置明确迁为 null，不把数组第一项冒充用户选择。
 */
export function migrateSettings(persisted: unknown, version: number): unknown {
  if (version >= SETTINGS_VERSION) return persisted;
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) return persisted;

  let state = { ...(persisted as Record<string, unknown>) };
  if (version < 1 && Array.isArray(state.providers)) {
    state = {
      ...state,
      providers: state.providers.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const provider = entry as Record<string, unknown>;
        if (typeof provider.oauthProviderId !== 'string') return provider;
        const { oauthProviderId, ...rest } = provider;
        return { ...rest, oauthAccountKey: oauthProviderId };
      }),
    };
  }

  if (version < 2) {
    state = { ...state, defaultModel: null };
  }
  return state;
}
