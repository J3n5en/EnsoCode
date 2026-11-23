import path from 'node:path';
import { app, ipcMain } from '@platform';
import type { SessionChangeSnapshots } from '@shared/types/fileChanges';
import { IPC_CHANNELS } from '@shared/types/ipc';
import {
  liveConversationIds,
  pruneSnapshots,
  readSnapshots,
  writeSnapshots,
} from '../services/changesSnapshots';
import { readSettings } from './settings';

const snapshotsDir = (): string => path.join(app.getPath('userData'), 'changes-snapshots');

function conversationIdOf(request: unknown): string | null {
  const id = (request as { conversationId?: unknown } | null)?.conversationId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** 畸形入参返回 null 而非 {}：空对象在 service 层语义是删文件 */
function snapshotsOf(request: unknown): SessionChangeSnapshots | null {
  const raw = (request as { snapshots?: unknown } | null)?.snapshots;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: SessionChangeSnapshots = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || value === null) out[key] = value;
  }
  return out;
}

/** 已删除会话的快照文件在首次访问时清一次；读不到会话表宁可不删 */
let pruned = false;
function pruneOnce(): void {
  if (pruned) return;
  pruned = true;
  const live = liveConversationIds(readSettings());
  if (live) pruneSnapshots(snapshotsDir(), live);
}

export function registerChangesHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHANGES_SNAPSHOTS_READ,
    (_event, request: unknown): SessionChangeSnapshots => {
      pruneOnce();
      const id = conversationIdOf(request);
      return id ? readSnapshots(snapshotsDir(), id) : {};
    }
  );

  ipcMain.handle(IPC_CHANNELS.CHANGES_SNAPSHOTS_WRITE, (_event, request: unknown): boolean => {
    pruneOnce();
    const id = conversationIdOf(request);
    const snapshots = snapshotsOf(request);
    return id && snapshots ? writeSnapshots(snapshotsDir(), id, snapshots) : false;
  });
}
