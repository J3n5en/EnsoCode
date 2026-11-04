import { join } from 'node:path';
import { app, ipcMain, shell } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import { broadcastToRenderers } from '../services/renderers';
import { ensureUserCss, readUserCss, USER_CSS_FILE, watchUserCss } from '../services/userCss';

/** user.css 属于 Main：渲染层不传路径，两个通道都不收参数 */
export function registerAppearanceHandlers(): void {
  const dir = app.getPath('userData');
  const file = join(dir, USER_CSS_FILE);
  let watching = false;

  ipcMain.handle(IPC_CHANNELS.APPEARANCE_USER_CSS_GET, () => {
    if (!watching) {
      try {
        watchUserCss(dir, () => broadcastToRenderers(IPC_CHANNELS.APPEARANCE_USER_CSS_CHANGED));
        watching = true;
      } catch {}
    }
    return readUserCss(file);
  });

  ipcMain.handle(IPC_CHANNELS.APPEARANCE_USER_CSS_OPEN, async () => {
    try {
      await ensureUserCss(file);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const failure = await shell.openPath(file);
    return failure ? { ok: false, error: failure } : { ok: true };
  });
}
