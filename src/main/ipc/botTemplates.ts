import path from 'node:path';
import { parseTemplateLibrary } from '@shared/bots/templateLibrary';
import { IPC_CHANNELS } from '@shared/types';
import { app, ipcMain } from 'electron';
import { readJson, writeJsonAtomic } from '../services/bots/files';
import { sendToAllWindows } from '../windows/createAppWindow';
import { isMainWebContents } from '../windows/MainWindow';
import { isSettingsWebContents } from '../windows/SettingsWindow';

const libraryPath = () => path.join(app.getPath('userData'), 'bot-templates.json');
const trusted = (id: number) => isMainWebContents(id) || isSettingsWebContents(id);

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
    sendToAllWindows(IPC_CHANNELS.BOT_TEMPLATES_CHANGED, library);
    return { ok: true, library };
  });
}
