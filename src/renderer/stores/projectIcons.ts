import type { ProjectIconInfo } from '@shared/projectIcon';
import { create } from 'zustand';

export type ProjectIconSetResult = Awaited<ReturnType<typeof window.electronAPI.projects.setIcon>>;

interface ProjectIconsState {
  icons: Record<string, ProjectIconInfo>;
  pending: Set<string>;
  ensure: (projectId: string) => void;
  set: (projectId: string, info: ProjectIconInfo) => void;
}

export const useProjectIconsStore = create<ProjectIconsState>((set, get) => ({
  icons: {},
  pending: new Set<string>(),
  ensure: (projectId) => {
    const state = get();
    if (state.icons[projectId] || state.pending.has(projectId)) return;
    const pending = new Set(state.pending);
    pending.add(projectId);
    set({ pending });
    void Promise.resolve()
      .then(() => window.electronAPI.projects.getIcon(projectId))
      .then((info) => {
        set((current) =>
          current.icons[projectId] ? current : { icons: { ...current.icons, [projectId]: info } }
        );
      })
      .catch(() => undefined)
      .finally(() => {
        set((current) => {
          if (!current.pending.has(projectId)) return current;
          const next = new Set(current.pending);
          next.delete(projectId);
          return { pending: next };
        });
      });
  },
  set: (projectId, info) => {
    set((current) => ({ icons: { ...current.icons, [projectId]: info } }));
  },
}));
