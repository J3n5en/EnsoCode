/**
 * Zustand persist 存储适配器：通过 IPC 持久化到主进程的 settings.json
 */

/**
 * 已完成首次水合（persist 已 merge 磁盘状态）的 store 名。
 * zustand persist 对每次 setState 都会 setItem（不看是否已水合），窗口刚起时任何早于
 * merge 的 setState（如 Main 的 source-authority 广播）都会把「默认值 + 一个字段」整份写回，
 * 覆盖磁盘配置并广播给其他窗口 → 设置全丢。
 * 闸门不能在 getItem 返回时开：从 read 回包到 persist merge 之间还有几个 microtask，
 * 内存仍是 initialState。各 store 在 onRehydrateStorage 回调首行调 openPersistWriteGate，
 * 这正是 merge 之后、回调自身补写之前的那一点。开闸前的写入直接丢弃，不排队。
 */
const hydratedNames = new Set<string>();

/** 本渲染进程发出的落盘次数。跨窗口同步用它判断重读在途时是否有本地写抢跑。 */
let writeGeneration = 0;
export const getWriteGeneration = (): number => writeGeneration;

/** persist 已把磁盘状态 merge 进内存，之后的落盘可放行。读失败（error 有值）不得调用。 */
export function openPersistWriteGate(name: string): void {
  hydratedNames.add(name);
}

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
    if (!hydratedNames.has(name)) return;
    writeGeneration++;
    await window.electronAPI.settings.writeKey(name, JSON.parse(value));
  },

  removeItem: async (name: string): Promise<void> => {
    if (!hydratedNames.has(name)) return;
    writeGeneration++;
    await window.electronAPI.settings.writeKey(name, undefined);
  },
};
