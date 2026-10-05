interface Slot {
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  task: () => Promise<unknown>;
  waiters: (() => void)[];
}

/**
 * 按 key 合并刷新：delayMs 内的多次请求只跑一次（用最后一次给的任务）；
 * 执行期间又被请求则本次结束后再跑一次。任务失败只吞掉，所有调用方都会 resolve。
 */
export function createCoalescer(delayMs = 50) {
  const slots = new Map<string, Slot>();

  const flush = async (key: string, slot: Slot) => {
    slot.timer = undefined;
    slot.running = true;
    const waiters = slot.waiters;
    slot.waiters = [];
    try {
      await slot.task();
    } catch {
      // 刷新失败等下一次事件再拉
    }
    slot.running = false;
    for (const resolve of waiters) resolve();
    if (slot.waiters.length > 0) schedule(key, slot);
    else slots.delete(key);
  };

  const schedule = (key: string, slot: Slot) => {
    slot.timer = setTimeout(() => void flush(key, slot), delayMs);
  };

  return (key: string, task: () => Promise<unknown>): Promise<void> =>
    new Promise<void>((resolve) => {
      const slot = slots.get(key) ?? { running: false, task, waiters: [] };
      slots.set(key, slot);
      slot.task = task;
      slot.waiters.push(resolve);
      if (!slot.running && !slot.timer) schedule(key, slot);
    });
}
