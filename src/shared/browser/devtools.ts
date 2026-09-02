/** DevTools 前端占着 guest 时不能再 attach debugger（Electron 互斥）。 */
export const DEVTOOLS_BUSY_ERROR = 'DevTools is open; close it to use browser CDP / screenshots.';

export function assertDevtoolsIdle(devtoolsOpen: boolean): void {
  if (devtoolsOpen) throw new Error(DEVTOOLS_BUSY_ERROR);
}
