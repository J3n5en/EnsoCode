import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ userData: '', channels: [] as string[] }));
vi.mock('electron', () => ({
  app: { getPath: () => m.userData },
  ipcMain: { handle: (channel: string) => m.channels.push(channel) },
}));

import { registerUpdaterHandlers } from './updater';

describe('更新重启的会话恢复只走 restart-manifest', () => {
  it('启动时删掉旧版留下的 interrupted-by-update.json，也不再开放取名单续跑的通道', () => {
    m.userData = mkdtempSync(path.join(tmpdir(), 'enso-updater-ipc-'));
    const legacy = path.join(m.userData, 'interrupted-by-update.json');
    writeFileSync(legacy, JSON.stringify({ v: 1, at: Date.now(), sessionIds: ['s1'] }));
    registerUpdaterHandlers();
    expect(existsSync(legacy)).toBe(false);
    expect(m.channels).not.toContain('updater:takeInterruptedSessions');
    expect(m.channels).not.toContain('updater:cancelRestart');
    expect(m.channels).toContain('updater:quitAndInstall');
  });
});
