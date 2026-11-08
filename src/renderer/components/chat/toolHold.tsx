import { createContext, useContext } from 'react';

/** 用户手动展开、并且还在聊天滚动视窗里的工具行。折叠时这些 key 留在组外。 */
export type ToolHoldApi = {
  report: (key: string, held: boolean) => void;
  scroller: { readonly current: HTMLElement | null };
};

const EMPTY_TOOL_HOLD: ToolHoldApi = {
  report: () => {},
  scroller: { current: null },
};

const ToolHoldContext = createContext<ToolHoldApi>(EMPTY_TOOL_HOLD);

export const ToolHoldProvider = ToolHoldContext.Provider;

export function useToolHold(): ToolHoldApi {
  return useContext(ToolHoldContext);
}
