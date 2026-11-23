import path from 'node:path';
import { app, ipcMain } from '@platform';
import { parseTemplateLibrary } from '@shared/bots/templateLibrary';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { readJson, writeJsonAtomic } from '../services/bots/files';
import { broadcastToRenderers, isMainRenderer, isSettingsRenderer } from '../services/renderers';

const libraryPath = () => path.join(app.getPath('userData'), 'bot-templates.json');
const trusted = (id: number) => isMainRenderer(id) || isSettingsRenderer(id);

export function registerBotTemplateHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.BOT_TEMPLATES_GET, (event) => {
    if (!trusted(event.sender.id)) return { ok: false, error: 'Invalid request.' };
    return { ok: true, library: parseTemplateLibrary(readJson(libraryPath())) };
  });

  ipcMain.handle(IPC_CHANNELS.BOT_TEMPLATES_SAVE, (event, request: unknown) => {
    if (!trusted(event.sender.id) || !request || typeof request !== 'object')
      return { ok: false, error: 'Invalid request.' };
    const library = parseTemplateLibrary(request);
    try {
      writeJsonAtomic(libraryPath(), library);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    broadcastToRenderers(IPC_CHANNELS.BOT_TEMPLATES_CHANGED, library);
    return { ok: true, library };
  });
}
