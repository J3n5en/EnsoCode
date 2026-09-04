/**
 * 持久化数据的版本迁移。
 *
 * 为什么用 zustand persist 的 `migrate` 而不是 `onRehydrateStorage`：
 * `migrate` 只在持久版本落后时跑一次，结果随下一次落盘写回磁盘，旧字段就此消失
 * （persist 紧随 migrate 的那次回写发生在水合闸门打开前，会被 storage.ts 丢弃；
 * 因此 migrate 必须幂等，落盘前每次启动都会重跑一遍）；
 * `onRehydrateStorage` 每次 rehydrate（含多窗口同步广播）都会执行，且不触发回写，
 * 等于把一次性的形状迁移变成永久的读侧补丁。
 */

/** 当前持久化数据版本；改数据形状时 +1 并在 `migrateSettings` 里加一段 */
export const SETTINGS_VERSION = 4;

/**
 * v0 → v1：`ModelProvider.oauthProviderId` 改名为 `oauthAccountKey`。
 * v1 → v2：新增必填 `defaultModel`，旧设置明确迁为 null，不把数组第一项冒充用户选择。
 * v2 → v3：新增标题总结：缺省关闭（不让升级用户静默多烧 token）、无独立模型。
 * v3 → v4：新增助手代审模型，缺省未选（该档禁用）。
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

  if (version < 3) {
    state = { ...state, titleSummaryEnabled: false, titleSummaryModel: null };
  }
  if (version < 4) {
    state = { ...state, approvalReviewer: null };
  }
  return state;
}
