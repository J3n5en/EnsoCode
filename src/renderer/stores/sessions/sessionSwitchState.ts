import { create } from 'zustand';

/** 侧栏算好的 ⌘1–9 槽位与顶栏标签；顶栏挂载时槽位改按顶栏标签顺序编号 */
interface SessionSwitchState {
  modHeld: boolean;
  headerMounted: boolean;
  activeIds: string[];
  slots: string[];
  /** 用户移出顶栏的会话及其时刻；之后有新消息会重新出现，重新打开即清除 */
  dismissed: Record<string, number>;
}

export const useSessionSwitchState = create<SessionSwitchState>(() => ({
  modHeld: false,
  headerMounted: false,
  activeIds: [],
  slots: [],
  dismissed: {},
}));

export function dismissHeaderTab(id: string): void {
  useSessionSwitchState.setState((s) => ({ dismissed: { ...s.dismissed, [id]: Date.now() } }));
}

export function restoreHeaderTab(id: string): void {
  const { dismissed } = useSessionSwitchState.getState();
  if (!(id in dismissed)) return;
  const { [id]: _, ...rest } = dismissed;
  useSessionSwitchState.setState({ dismissed: rest });
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

export function publishSessionSwitch(activeIds: string[], slots: string[]): void {
  const prev = useSessionSwitchState.getState();
  if (sameIds(prev.activeIds, activeIds) && sameIds(prev.slots, slots)) return;
  useSessionSwitchState.setState({ activeIds, slots });
}
