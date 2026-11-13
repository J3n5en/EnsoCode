import { create } from 'zustand';

/** 侧栏算好的 ⌘1–9 槽位与顶栏标签；顶栏挂载时槽位改按顶栏标签顺序编号 */
interface SessionSwitchState {
  modHeld: boolean;
  headerMounted: boolean;
  activeIds: string[];
  slots: string[];
}

export const useSessionSwitchState = create<SessionSwitchState>(() => ({
  modHeld: false,
  headerMounted: false,
  activeIds: [],
  slots: [],
}));

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

export function publishSessionSwitch(activeIds: string[], slots: string[]): void {
  const prev = useSessionSwitchState.getState();
  if (sameIds(prev.activeIds, activeIds) && sameIds(prev.slots, slots)) return;
  useSessionSwitchState.setState({ activeIds, slots });
}
