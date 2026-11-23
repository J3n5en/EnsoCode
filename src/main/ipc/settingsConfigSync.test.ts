import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(path.join(tmpdir(), 'enso-settings-config-sync-'));
const send = vi.fn();
const webContents = { isDestroyed: () => false, send };

vi.mock('electron', () => ({
  app: { getPath: () => userData, on: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents }],
  },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../services/uiHost', async () =>
  (await import('../../../test/helpers/localUi')).mockUiHost(() => [
    { isDestroyed: () => false, webContents: { id: 1, ...webContents } },
  ])
);

const file = path.join(userData, 'settings.json');
writeFileSync(
  file,
  JSON.stringify({
    'enso-settings': { version: 7, state: { theme: 'dark', providers: [] } },
    'enso-conversations': { state: { conversations: { keep: true } } },
  })
);
chmodSync(file, 0o644);
const settings = await import('./settings');

afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe('config sync settings transaction', () => {
  it('durable commit 保留无关 store，备份为仅用户可读并在成功后广播', () => {
    const current = settings.readSettings();
    const result = settings.commitSettingsTransaction(settings.settingsFingerprint(current), {
      providers: [{ id: 'imported' }],
    });

    expect(result.ok).toBe(true);
    expect(statSync(result.backupPath as string).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    expect(persisted['enso-settings'].state).toMatchObject({
      theme: 'dark',
      providers: [{ id: 'imported' }],
    });
    expect(persisted['enso-conversations'].state.conversations.keep).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('预览后设置发生变化时拒绝提交且不生成第二次广播', () => {
    const fingerprint = settings.settingsFingerprint(settings.readSettings());
    settings.patchSettingsState('theme', 'light');
    send.mockClear();
    const result = settings.commitSettingsTransaction(fingerprint, { providers: [] });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('changed');
    expect(send).not.toHaveBeenCalled();
  });

  it('预览后无关 store（enso-conversations）变化不应阻断提交', () => {
    const fingerprint = settings.settingsFingerprint(settings.readSettings());
    const cached = settings.readSettings() as Record<string, unknown>;
    const conversations = (cached['enso-conversations'] as { state: Record<string, unknown> }).state
      .conversations as Record<string, unknown>;
    conversations.addedAfterPreview = true;

    const result = settings.commitSettingsTransaction(fingerprint, {
      providers: [{ id: 'after-conversations' }],
    });

    expect(result).toMatchObject({ ok: true });
  });

  it('预览后 excluded 字段变化保留提交时刻的本机值', () => {
    const fingerprint = settings.settingsFingerprint(settings.readSettings());
    settings.patchSettingsState('projects', [{ id: 'local-latest' }]);
    settings.patchSettingsState('customProxyUrl', 'http://local-latest:1080');

    const result = settings.commitSettingsTransaction(fingerprint, {
      providers: [{ id: 'excluded-check' }],
    });

    expect(result).toMatchObject({ ok: true });
    const state = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))[
      'enso-settings'
    ].state;
    expect(state.projects).toEqual([{ id: 'local-latest' }]);
    expect(state.customProxyUrl).toBe('http://local-latest:1080');
    expect(state.providers).toEqual([{ id: 'excluded-check' }]);
  });

  it('commit 只应用 SYNC_FIELDS，patch 中的 excluded 字段被忽略', () => {
    settings.patchSettingsState('onboarded', true);
    settings.patchSettingsState('proxyMode', 'system');
    const fingerprint = settings.settingsFingerprint(settings.readSettings());

    const result = settings.commitSettingsTransaction(fingerprint, {
      providers: [{ id: 'whitelist' }],
      onboarded: false,
      proxyMode: 'custom',
      customProxyUrl: 'http://imported:9',
    });

    expect(result).toMatchObject({ ok: true });
    const state = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))[
      'enso-settings'
    ].state;
    expect(state.onboarded).toBe(true);
    expect(state.proxyMode).toBe('system');
    expect(state.customProxyUrl).not.toBe('http://imported:9');
  });

  it('canonical editMode 提交删除本机遗留 hashline bool', () => {
    const current = settings.readSettings() as Record<string, unknown>;
    const state = (current['enso-settings'] as { state: Record<string, unknown> }).state;
    state.hashlineEditEnabled = true;
    delete state.editMode;

    const result = settings.commitSettingsTransaction(settings.settingsFingerprint(current), {
      editMode: 'apply_patch',
    });
    expect(result).toMatchObject({ ok: true });
    const persisted = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))[
      'enso-settings'
    ].state;
    expect(persisted.editMode).toBe('apply_patch');
    expect(persisted).not.toHaveProperty('hashlineEditEnabled');
  });

  it('config-sync 备份只保留最近 5 份', () => {
    for (let i = 0; i < 7; i += 1) {
      const result = settings.commitSettingsTransaction(
        settings.settingsFingerprint(settings.readSettings()),
        { theme: i % 2 === 0 ? 'dark' : 'light' }
      );
      expect(result.ok).toBe(true);
    }
    const backups = readdirSync(userData).filter(
      (file) => file.startsWith('settings.config-sync-backup-') && file.endsWith('.json')
    );
    expect(backups).toHaveLength(5);
  });
});
