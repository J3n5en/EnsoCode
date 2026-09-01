import type { TerminalCreateRequest, TerminalCreateResult } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import {
  createTerminal,
  disposeTerminal,
  resizeTerminal,
  writeTerminal,
} from '../services/terminalService';

function toCreateRequest(value: unknown): TerminalCreateRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.termId !== 'string' || v.termId.length === 0) return null;
  return {
    termId: v.termId,
    cwd: typeof v.cwd === 'string' ? v.cwd : undefined,
    cols: typeof v.cols === 'number' ? v.cols : undefined,
    rows: typeof v.rows === 'number' ? v.rows : undefined,
  };
}

export function registerTerminalHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_CREATE,
    (event, request: unknown): TerminalCreateResult => {
      const parsed = toCreateRequest(request);
      if (!parsed) return { ok: false, error: 'Invalid request' };
      return createTerminal(parsed, event.sender);
    }
  );

  ipcMain.handle(IPC_CHANNELS.TERMINAL_WRITE, (_event, termId: unknown, data: unknown): void => {
    if (typeof termId !== 'string' || typeof data !== 'string') return;
    writeTerminal(termId, data);
  });

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_RESIZE,
    (_event, termId: unknown, cols: unknown, rows: unknown): void => {
      if (typeof termId !== 'string' || typeof cols !== 'number' || typeof rows !== 'number')
        return;
      resizeTerminal(termId, Math.floor(cols), Math.floor(rows));
    }
  );

  ipcMain.handle(IPC_CHANNELS.TERMINAL_DISPOSE, (_event, termId: unknown): void => {
    if (typeof termId !== 'string') return;
    disposeTerminal(termId);
  });
}
