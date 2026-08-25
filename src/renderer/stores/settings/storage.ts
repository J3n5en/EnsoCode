/**
 * Zustand persist 存储适配器：通过 IPC 持久化到主进程的 settings.json
 */
export const electronStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const data = await window.electronAPI.settings.read();
    if (data && typeof data === 'object' && name in data) {
      return JSON.stringify((data as Record<string, unknown>)[name]);
    }
    return null;
  },

  // 按键写：主进程合并到最新全量,避免与其他 store/窗口的写互相覆盖
  setItem: async (name: string, value: string): Promise<void> => {
    await window.electronAPI.settings.writeKey(name, JSON.parse(value));
  },

  removeItem: async (name: string): Promise<void> => {
    await window.electronAPI.settings.writeKey(name, undefined);
  },
};
