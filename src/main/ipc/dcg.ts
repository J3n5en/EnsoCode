import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import type { DcgActionResult, DcgStatus } from '@shared/types/dcg';
import { DCG_VERSION, dcgRoot, dcgStatus, installDcg, uninstallDcg } from '../services/dcgBinary';
import { isMainRenderer, isSettingsRenderer } from '../services/renderers';

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const UNTRUSTED: DcgStatus = { supported: false, installed: false, version: DCG_VERSION };

const isTrusted = (id: number) => isMainRenderer(id) || isSettingsRenderer(id);

let installing: Promise<DcgActionResult> | null = null;

export function registerDcgHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.DCG_STATUS, (event) =>
    isTrusted(event.sender.id) ? dcgStatus(dcgRoot()) : UNTRUSTED
  );

  ipcMain.handle(IPC_CHANNELS.DCG_INSTALL, (event): Promise<DcgActionResult> => {
    if (!isTrusted(event.sender.id)) return Promise.resolve({ ok: false, status: UNTRUSTED });
    installing ??= installDcg({ root: dcgRoot() })
      .then(() => ({ ok: true, status: dcgStatus(dcgRoot()) }))
      .catch((error: unknown) => ({
        ok: false,
        status: dcgStatus(dcgRoot()),
        error: toErrorMessage(error),
      }))
      .finally(() => {
        installing = null;
      });
    return installing;
  });

  ipcMain.handle(IPC_CHANNELS.DCG_UNINSTALL, async (event): Promise<DcgActionResult> => {
    if (!isTrusted(event.sender.id) || installing)
      return { ok: false, status: dcgStatus(dcgRoot()) };
    try {
      await uninstallDcg(dcgRoot());
      return { ok: true, status: dcgStatus(dcgRoot()) };
    } catch (error) {
      return { ok: false, status: dcgStatus(dcgRoot()), error: toErrorMessage(error) };
    }
  });
}
