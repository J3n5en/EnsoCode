import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(path.join(tmpdir(), 'enso-settings-backup-'));

vi.mock('electron', () => ({
  app: { getPath: () => userData, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));

const settingsPath = path.join(userData, 'settings.json');
const withProviders = (providers: unknown[], extra: Record<string, unknown> = {}) => ({
  'enso-settings': { version: 2, state: { providers, skills: [], mcpServers: [], ...extra } },
});
const backups = () => readdirSync(userData).filter((f) => f.startsWith('settings.backup-'));

let settings: typeof import('./settings');
const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeAll(async () => {
  writeFileSync(settingsPath, JSON.stringify(withProviders([{ id: 'a' }])));
  settings = await import('./settings');
});
afterEach(() => warn.mockClear());
afterAll(() => {
  settings.flushSettings();
  rmSync(userData, { recursive: true, force: true });
});

describe('settings 破坏性写入护栏', () => {
  it('普通写入不产生备份', () => {
    settings.patchSettingsState('theme', 'dark');
    expect(backups()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('把非空 providers 写成空时，先把上一份配置快照到 settings.backup-*.json 并告警', () => {
    const result = settings.patchSettingsState('providers', []);
    expect(result.ok).toBe(true);

    const files = backups();
    expect(files).toHaveLength(1);
    const snapshot = JSON.parse(readFileSync(path.join(userData, files[0]), 'utf-8'));
    expect(snapshot['enso-settings'].state.providers).toEqual([{ id: 'a' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('providers');
  });

  it('空 → 空不算破坏性，不再重复快照', () => {
    settings.patchSettingsState('providers', []);
    expect(backups()).toHaveLength(1);
  });

  it('快照数量有上限，只留最近几份', () => {
    for (let i = 0; i < 8; i++) {
      settings.patchSettingsState('skills', [{ id: `s${i}` }]);
      settings.patchSettingsState('skills', []);
    }
    expect(backups().length).toBeLessThanOrEqual(5);
    expect(existsSync(settingsPath)).toBe(true);
  });
});
