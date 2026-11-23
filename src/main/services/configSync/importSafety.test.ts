import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { encodeBundle } from './codec';
import type { ConfigSyncBundle } from './types';

const userData = mkdtempSync(`${tmpdir()}/enso-config-safety-`);
const settingsPath = `${userData}/settings.json`;

vi.mock('electron', () => ({
  app: { getPath: () => userData, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));

const emptyBundle = (): ConfigSyncBundle => ({
  format: 'enso-config',
  version: 1,
  createdAt: '2025-09-05T00:00:00.000Z',
  state: {
    providers: [],
    skills: [],
    mcpServers: [],
    instructions: [],
    presets: [],
    agentTypes: [],
    subagentModels: [],
  },
  resources: { skills: [], instructions: [] },
  secretsIncluded: false,
});

writeFileSync(
  settingsPath,
  JSON.stringify({
    'enso-settings': {
      version: 1,
      state: {
        theme: 'dark',
        providers: [],
        skills: [],
        mcpServers: [],
        instructions: [],
        presets: [],
        agentTypes: [],
        subagentModels: [],
      },
    },
  })
);
const service = await import('./index');
const settings = await import('../../ipc/settings');

afterAll(() => {
  chmodSync(userData, 0o700);
  service.clearConfigSyncTokens();
  rmSync(userData, { recursive: true, force: true });
});

async function writeIncoming(name: string): Promise<string> {
  const file = `${userData}/${name}.enso-config`;
  writeFileSync(file, await encodeBundle(emptyBundle()));
  return file;
}

function persistedState(): Record<string, unknown> {
  const persisted = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    'enso-settings': { state: Record<string, unknown> };
  };
  return persisted['enso-settings'].state;
}

describe('config sync import safety', () => {
  it('预览后 settings 指纹变化时拒绝提交并保留最新本机状态', async () => {
    const opened = await service.openImportForSender(31, await writeIncoming('stale'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await expect(
      service.previewImportForSender(31, opened.token, undefined, 'merge')
    ).resolves.toMatchObject({ ok: true });
    expect(settings.patchSettingsState('theme', 'changed')).toMatchObject({ ok: true });
    expect(settings.flushSettings()).toBe(true);

    await expect(service.commitImportForSender(31, opened.token, 'merge')).resolves.toMatchObject({
      ok: false,
    });
    expect(persistedState().theme).toBe('changed');
  });

  it('提交模式与预览模式不一致时要求重新预览', async () => {
    const opened = await service.openImportForSender(32, await writeIncoming('mode'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await expect(
      service.previewImportForSender(32, opened.token, undefined, 'merge')
    ).resolves.toMatchObject({ ok: true, mode: 'merge' });
    await expect(service.commitImportForSender(32, opened.token, 'replace')).resolves.toMatchObject(
      { ok: false }
    );
  });

  it('取消后 token 不可再次预览', async () => {
    const opened = await service.openImportForSender(33, await writeIncoming('cancel'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    service.cancelImportForSender(33, opened.token);
    await expect(
      service.previewImportForSender(33, opened.token, undefined, 'merge')
    ).resolves.toMatchObject({ ok: false });
  });

  it('成功提交后 token 不可重复消费', async () => {
    const opened = await service.openImportForSender(34, await writeIncoming('consume'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await service.previewImportForSender(34, opened.token, undefined, 'merge');
    await expect(service.commitImportForSender(34, opened.token, 'merge')).resolves.toMatchObject({
      ok: true,
    });
    await expect(service.commitImportForSender(34, opened.token, 'merge')).resolves.toMatchObject({
      ok: false,
    });
  });

  it('备份或原子写入失败时不改变 settings 主状态', async () => {
    const before = persistedState();
    const opened = await service.openImportForSender(35, await writeIncoming('readonly'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await service.previewImportForSender(35, opened.token, undefined, 'merge');

    chmodSync(userData, 0o500);
    try {
      await expect(service.commitImportForSender(35, opened.token, 'merge')).resolves.toMatchObject(
        { ok: false }
      );
    } finally {
      chmodSync(userData, 0o700);
    }
    expect(persistedState()).toEqual(before);
  });
});
