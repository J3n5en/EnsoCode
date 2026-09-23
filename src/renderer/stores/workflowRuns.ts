import type { WorkflowRunSnapshot } from '@shared/types/workflow';
import { create } from 'zustand';

const MAX_RUNS = 8;

interface WorkflowRunsState {
  byConversation: Record<string, WorkflowRunSnapshot[]>;
  upsert: (conversationId: string, run: WorkflowRunSnapshot) => void;
  forget: (conversationId: string) => void;
}

export const useWorkflowRunsStore = create<WorkflowRunsState>((set) => ({
  byConversation: {},
  upsert: (conversationId, run) =>
    set((state) => {
      const current = state.byConversation[conversationId] ?? [];
      const next = [run, ...current.filter((item) => item.runId !== run.runId)].slice(0, MAX_RUNS);
      return { byConversation: { ...state.byConversation, [conversationId]: next } };
    }),
  forget: (conversationId) =>
    set((state) => {
      if (!state.byConversation[conversationId]) return state;
      const byConversation = { ...state.byConversation };
      delete byConversation[conversationId];
      return { byConversation };
    }),
}));
