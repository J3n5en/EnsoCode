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

  setItem: async (name: string, value: string): Promise<void> => {
    const existingData = (await window.electronAPI.settings.read()) || {};
    const newData = {
      ...(typeof existingData === 'object' ? existingData : {}),
      [name]: JSON.parse(value),
    };
    await window.electronAPI.settings.write(newData);
  },

  removeItem: async (name: string): Promise<void> => {
    const existingData = (await window.electronAPI.settings.read()) || {};
    if (typeof existingData === 'object' && existingData !== null) {
      const newData = { ...existingData } as Record<string, unknown>;
      delete newData[name];
      await window.electronAPI.settings.write(newData);
    }
  },
};
