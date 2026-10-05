import type {
  MemoryMutationResult,
  PendingMemoryWriteDecision,
  PendingMemoryWriteDto,
} from '@shared/memory/dto';
import { useEffect } from 'react';
import { create } from 'zustand';

/** Bot 成员写 project / global 记忆的待审批项；收件箱与记忆库审批入口共用 */
interface PendingMemoryWritesState {
  items: PendingMemoryWriteDto[];
  refresh: () => Promise<void>;
  review: (id: string, decision: PendingMemoryWriteDecision) => Promise<MemoryMutationResult>;
}

export const usePendingMemoryWritesStore = create<PendingMemoryWritesState>((set, get) => ({
  items: [],
  refresh: async () => {
    try {
      set({ items: await window.electronAPI.memory.pendingWrites() });
    } catch {
      // 只影响审批入口展示
    }
  },
  review: async (id, decision) => {
    const result = await window.electronAPI.memory.reviewPendingWrite(id, decision);
    if (result.ok) set({ items: get().items.filter((item) => item.id !== id) });
    await get().refresh();
    return result;
  },
}));

let bindings = 0;
let unsubscribe: (() => void) | null = null;

/** 订阅记忆变更并拉一次；引用计数，返回清理函数 */
export function bindPendingMemoryWrites(): () => void {
  bindings += 1;
  if (!unsubscribe) {
    const { refresh } = usePendingMemoryWritesStore.getState();
    unsubscribe = window.electronAPI.memory.onChanged(() => void refresh());
    void refresh();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    bindings -= 1;
    if (bindings === 0) {
      unsubscribe?.();
      unsubscribe = null;
    }
  };
}

export function usePendingMemoryWrites(): PendingMemoryWriteDto[] {
  useEffect(() => bindPendingMemoryWrites(), []);
  return usePendingMemoryWritesStore((state) => state.items);
}
