import type { AgyAuthStatus, AgyModelOption } from '@shared/agy/types';
import { create } from 'zustand';

export const useAgyAuthStore = create<{
  status: AgyAuthStatus;
  setStatus: (status: AgyAuthStatus) => void;
}>((set) => ({
  status: { status: 'unknown' },
  setStatus: (status) => set({ status }),
}));

export function agyModelsFromStatus(status: AgyAuthStatus): AgyModelOption[] {
  return status.status === 'signed-in' ? status.models : [];
}
