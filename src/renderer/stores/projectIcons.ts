import type { ProjectIconInfo } from '@shared/projectIcon';
import { create } from 'zustand';

export type ProjectIconSetResult = Awaited<ReturnType<typeof window.electronAPI.projects.setIcon>>;

interface ProjectIconsState {
  icons: Record<string, ProjectIconInfo>;
  pending: Set<string>;
  ensure: (projectId: string) => void;
  set: (projectId: string, info: ProjectIconInfo) => void;
}

const queuedIds = new Set<string>();
let flushScheduled = false;

export const useProjectIconsStore = create<ProjectIconsState>((set, get) => {
  const flush = (): void => {
    flushScheduled = false;
    const batch = [...queuedIds].filter((id) => !get().icons[id]).sort();
    queuedIds.clear();
    if (batch.length === 0) return;

    const api = window.electronAPI.projects;
    const request =
      typeof api.getIcons === 'function'
        ? api.getIcons(batch)
        : Promise.all(batch.map(async (id) => [id, await api.getIcon(id)] as const)).then(
            (entries) => Object.fromEntries(entries)
          );

    void request
      .then((result) => {
        set((current) => {
          let nextIcons: Record<string, ProjectIconInfo> | null = null;
          for (const [id, info] of Object.entries(result)) {
            if (!current.icons[id] && info) {
              nextIcons ??= { ...current.icons };
              nextIcons[id] = info;
            }
          }
          return nextIcons ? { icons: nextIcons } : current;
        });
      })
      .catch(() => undefined)
      .finally(() => {
        set((current) => {
          let next: Set<string> | null = null;
          for (const id of batch) {
            if (!current.pending.has(id)) continue;
            next ??= new Set(current.pending);
            next.delete(id);
          }
          return next ? { pending: next } : current;
        });
      });
  };

  return {
    icons: {},
    pending: new Set<string>(),
    ensure: (projectId) => {
      const state = get();
      if (state.icons[projectId] || state.pending.has(projectId)) return;
      const pending = new Set(state.pending);
      pending.add(projectId);
      set({ pending });
      queuedIds.add(projectId);
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
    },
    set: (projectId, info) => {
      set((current) => ({ icons: { ...current.icons, [projectId]: info } }));
    },
  };
});
