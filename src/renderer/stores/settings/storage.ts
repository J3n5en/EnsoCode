/**
 * Zustand persist 存储适配器：通过 IPC 持久化到主进程的 settings.json
 */

/**
 * 已完成首次读取的 store 名。zustand persist 对每次 setState 都会 setItem（不看是否已水合），
 * 窗口刚起时任何早于 read 回包的 setState（如 Main 的 source-authority 广播）都会把
 * 「默认值 + 一个字段」整份写回，覆盖磁盘配置并广播给其他窗口 → 设置全丢。
 * 这里按 name 记录，首次 getItem 返回前一律丢弃写入；水合完成后的合并态会带上真实值。
 */
const hydratedNames = new Set<string>();

export const electronStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const data = await window.electronAPI.settings.read();
    hydratedNames.add(name);
    if (data && typeof data === 'object' && name in data) {
      return JSON.stringify((data as Record<string, unknown>)[name]);
    }
    return null;
  },

  // 按键写：主进程合并到最新全量,避免与其他 store/窗口的写互相覆盖
  setItem: async (name: string, value: string): Promise<void> => {
    if (!hydratedNames.has(name)) return;
    await window.electronAPI.settings.writeKey(name, JSON.parse(value));
  },

  removeItem: async (name: string): Promise<void> => {
    if (!hydratedNames.has(name)) return;
    await window.electronAPI.settings.writeKey(name, undefined);
  },
};
