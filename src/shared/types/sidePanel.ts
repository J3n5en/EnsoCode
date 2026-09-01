/** 右侧多类型 Tab 面板的共享类型（本期只实现 terminal，其余 kind 预留） */

export type SidePanelTabKind = 'terminal' | 'browser' | 'file';

export interface SidePanelTab {
  id: string;
  kind: SidePanelTabKind;
  title: string;
}

export interface TerminalCreateRequest {
  termId: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalCreateResult {
  ok: boolean;
  error?: string;
}

export interface TerminalDataEvent {
  termId: string;
  data: string;
}

export interface TerminalExitEvent {
  termId: string;
  exitCode: number;
}
