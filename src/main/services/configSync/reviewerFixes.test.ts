import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBundle, encodeBundle } from './codec';
import type { ConfigSyncBundle } from './types';

const userData = mkdtempSync(join(tmpdir(), 'enso-config-reviewer-fixes-'));
const settingsPath = join(userData, 'settings.json');
let shouldThrowOnBroadcast = true;
const send = vi.fn(() => {
  if (shouldThrowOnBroadcast) throw new Error('renderer send failed');
});
const webContents = { isDestroyed: () => false, send };

vi.mock('electron', () => ({
  app: { getPath: () => userData, on: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents }],
  },
  ipcMain: { handle: vi.fn() },
}));

let service: typeof import('./index');
let settings: typeof import('../../ipc/settings');

const emptyState = () => ({
  providers: [],
  skills: [],
  mcpServers: [],
  instructions: [],
  presets: [],
  agentTypes: [],
  subagentModels: [],
});

const bundle = (state: Partial<ConfigSyncBundle['state']> = {}): ConfigSyncBundle => ({
  format: 'enso-config',
  version: 1,
  createdAt: '2025-09-05T00:00:00.000Z',
  state: { ...emptyState(), ...state },
  resources: { skills: [], instructions: [] },
  secretsIncluded: false,
});

beforeAll(async () => {
  writeFileSync(
    settingsPath,
    JSON.stringify({
      'enso-settings': { version: 1, state: { theme: 'dark', ...emptyState() } },
    })
  );
  service = await import('./index');
  settings = await import('../../ipc/settings');
});

afterAll(() => {
  service.clearConfigSyncTokens();
  rmSync(userData, { recursive: true, force: true });
});

describe('config sync reviewer regressions', () => {
  it('renderer broadcast failure does not turn a durable settings commit into a failure', () => {
    const result = settings.commitSettingsTransaction(
      settings.settingsFingerprint(settings.readSettings()),
      {
        providers: [
          {
            id: 'committed',
            name: 'Committed',
            api: 'openai-completions',
            baseUrl: 'https://example.test',
            enabled: true,
            models: [{ id: 'model-1' }],
          },
        ],
      }
    );

    expect(result).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))['enso-settings'].state.providers).toEqual(
      [expect.objectContaining({ id: 'committed' })]
    );
    shouldThrowOnBroadcast = false;
  });

  it('successful import keeps staged resources when post-commit broadcast fails', async () => {
    shouldThrowOnBroadcast = true;
    const skillId = 'skill-imported';
    const incoming = bundle({
      skills: [
        {
          id: skillId,
          name: 'Imported skill',
          description: '',
          path: '',
          source: 'import',
          enabled: true,
        },
      ],
    });
    incoming.resources.skills = [
      {
        id: skillId,
        files: [{ path: 'SKILL.md', content: Buffer.from('# Skill').toString('base64') }],
      },
    ];
    const file = join(userData, 'broadcast-failure.enso-config');
    incoming.secretsIncluded = true;
    writeFileSync(file, await encodeBundle(incoming, 'correct horse'));

    const opened = await service.openImportForSender(101, file);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await expect(
      service.previewImportForSender(101, opened.token, 'correct horse', 'merge')
    ).resolves.toMatchObject({
      ok: true,
    });
    const committed = await service.commitImportForSender(101, opened.token, 'merge');

    expect(committed).toMatchObject({ ok: true });
    const imported = JSON.parse(readFileSync(settingsPath, 'utf8'))['enso-settings'].state
      .skills[0];
    expect(imported.path).toBeTruthy();
    expect(existsSync(imported.path)).toBe(true);
    shouldThrowOnBroadcast = false;
  });

  it('rejects an unsafe local instruction id before reading its content', async () => {
    const id = '../escaped-instruction';
    const escapedPath = join(userData, 'escaped-instruction.md');
    writeFileSync(escapedPath, 'must not be collected');
    settings.patchSettingsState('instructions', [
      {
        id,
        name: 'Unsafe',
        source: 'local',
        local: true,
        bytes: Buffer.byteLength('must not be collected'),
        enabled: false,
      },
    ]);
    const result = await service.exportConfigToPath(
      { includeSecrets: false },
      join(userData, 'unsafe-instruction.enso-config')
    );

    expect(result).toMatchObject({ ok: false });
  });

  it('derives exported instruction bytes from the content that was read', async () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const content = 'fresh instruction content';
    mkdirSync(join(userData, 'instructions'), { recursive: true });
    writeFileSync(join(userData, 'instructions', `${id}.md`), content);
    settings.patchSettingsState('instructions', [
      {
        id,
        name: 'Fresh instruction',
        source: 'local',
        local: true,
        bytes: 1,
        enabled: false,
      },
    ]);
    const file = join(userData, 'fresh-instruction.enso-config');
    const result = await service.exportConfigToPath(
      { includeSecrets: true, password: 'correct horse' },
      file
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const decoded = await decodeBundle(readFileSync(file), 'correct horse');
    expect(decoded.state.instructions[0]?.bytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('never exports or activates OAuth account keys, while preserving a matched local key', async () => {
    const localProvider = {
      id: 'local-oauth',
      name: 'Local OAuth',
      api: 'openai-completions' as const,
      baseUrl: 'https://example.test',
      enabled: true,
      oauthAccountKey: 'local-account',
      oauthAccountPool: { accountKeys: ['openai-codex', 'openai-codex#2'] },
      models: [{ id: 'model-1' }],
    };
    settings.patchSettingsState('providers', [localProvider]);
    const exported = join(userData, 'oauth-export.enso-config');
    const exportResult = await service.exportConfigToPath(
      { includeSecrets: true, password: 'correct horse' },
      exported
    );
    expect(exportResult).toMatchObject({ ok: true });
    const exportedBundle = await decodeBundle(readFileSync(exported), 'correct horse');
    expect(exportedBundle.state.providers[0]?.oauthAccountKey).toBeUndefined();
    expect(exportedBundle.state.providers[0]?.oauthAccountPool).toBeUndefined();
    expect(exportedBundle.state.providers[0]?.omittedFields).toContain('oauthAccountPool');

    const imported = bundle({
      providers: [
        { ...localProvider, oauthAccountKey: 'remote-account' },
        {
          ...localProvider,
          id: 'new-oauth',
          name: 'New OAuth',
          oauthAccountKey: 'remote-new-account',
        },
      ],
    });
    imported.secretsIncluded = true;
    const incoming = join(userData, 'oauth-import.enso-config');
    writeFileSync(incoming, await encodeBundle(imported, 'correct horse'));
    const opened = await service.openImportForSender(102, incoming);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await expect(
      service.previewImportForSender(102, opened.token, 'correct horse', 'merge')
    ).resolves.toMatchObject({ ok: true });
    expect(await service.commitImportForSender(102, opened.token, 'merge')).toMatchObject({
      ok: true,
    });

    const providers = JSON.parse(readFileSync(settingsPath, 'utf8'))['enso-settings'].state
      .providers;
    expect(providers).toContainEqual(
      expect.objectContaining({
        id: 'local-oauth',
        oauthAccountKey: 'local-account',
        oauthAccountPool: localProvider.oauthAccountPool,
      })
    );
    expect(providers).toContainEqual(expect.objectContaining({ id: 'new-oauth', enabled: false }));
    expect(
      providers.find((provider: { id: string }) => provider.id === 'new-oauth').oauthAccountKey
    ).toBeUndefined();
    expect(
      providers.find((provider: { id: string }) => provider.id === 'new-oauth').oauthAccountPool
    ).toBeUndefined();
  });
});
