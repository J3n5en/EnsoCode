import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBundle, encodeBundle, validateBundle } from './codec';
import { CONFIG_SYNC_FIELD_POLICY, SYNC_FIELDS } from './index';
import type { ConfigSyncBundle } from './types';

const userData = mkdtempSync(join(tmpdir(), 'enso-config-service-'));

vi.mock('electron', () => ({
  app: { getPath: () => userData, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));

let service: typeof import('./index');
let settings: typeof import('../../ipc/settings');

beforeAll(async () => {
  writeFileSync(
    join(userData, 'settings.json'),
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
  service = await import('./index');
  settings = await import('../../ipc/settings');
});

afterAll(() => {
  service.clearConfigSyncTokens();
  rmSync(userData, { recursive: true, force: true });
});

describe('config sync sender-bound import flow', () => {
  it.each(['merge', 'replace'] as const)(
    '子模型禁用状态经便携导出和 %s 导入后实际落盘',
    async (mode) => {
      const providers = [
        {
          id: 'sub-provider',
          name: 'Sub Provider',
          api: 'openai-completions',
          apiKey: 'local-only',
          baseUrl: 'https://example.test',
          enabled: true,
          models: [{ id: 'model' }],
        },
      ];
      const entry = {
        id: 'sub-model',
        providerId: 'sub-provider',
        modelId: 'model',
        description: '保留说明',
        reasoning: 'off',
        thinkingLevel: 'high',
        enabled: false,
      };
      const neighbor = { ...entry, id: 'neighbor', enabled: true };
      settings.patchSettingsState('providers', providers);
      settings.patchSettingsState('subagentModels', [entry, neighbor]);
      settings.patchSettingsState('subagentModelsEnabled', true);
      try {
        const file = join(userData, `subagent-${mode}.enso-config`);
        await expect(
          service.exportConfigToPath({ includeSecrets: false }, file)
        ).resolves.toMatchObject({
          ok: true,
        });
        expect((await decodeBundle(readFileSync(file))).state.subagentModels).toEqual([
          entry,
          neighbor,
        ]);
        settings.patchSettingsState('subagentModels', [{ ...entry, enabled: true }, neighbor]);
        const opened = await service.openImportForSender(50, file);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        await expect(
          service.previewImportForSender(50, opened.token, undefined, mode)
        ).resolves.toMatchObject({
          ok: true,
        });
        await expect(service.commitImportForSender(50, opened.token, mode)).resolves.toMatchObject({
          ok: true,
        });
        const persisted = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'));
        expect(persisted['enso-settings'].state.subagentModels).toEqual([entry, neighbor]);
        expect(persisted['enso-settings'].state.subagentModelsEnabled).toBe(true);
        expect(persisted['enso-settings'].state.providers).toEqual(providers);
      } finally {
        settings.patchSettingsState('subagentModels', []);
        settings.patchSettingsState('subagentModelsEnabled', false);
        settings.patchSettingsState('providers', []);
        settings.flushSettings();
      }
    }
  );

  it('所有持久化设置字段都有明确的同步策略', async () => {
    const { SETTINGS_STATE_FIELDS } = await import('../../ipc/settings');
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/stores/settings/types.ts'),
      'utf8'
    );
    const persistedSection =
      source.split('export interface SettingsState {')[1]?.split('  // Setters')[0] ?? '';
    const persistedFields = [...persistedSection.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):/gmu)]
      .map((match) => match[1])
      .sort();

    expect([...SETTINGS_STATE_FIELDS].sort()).toEqual(persistedFields);
    expect(Object.keys(CONFIG_SYNC_FIELD_POLICY).sort()).toEqual(persistedFields);
  });
  it('token 仅限打开它的 renderer，且提交保留非同步设置', async () => {
    const bundle: ConfigSyncBundle = {
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
    };
    const file = join(userData, 'incoming.enso-config');
    writeFileSync(file, await encodeBundle(bundle));

    const opened = await service.openImportForSender(10, file);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await expect(
      service.previewImportForSender(11, opened.token, undefined, 'merge')
    ).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      service.previewImportForSender(10, opened.token, undefined, 'merge')
    ).resolves.toMatchObject({
      ok: true,
      mode: 'merge',
    });
    const committed = await service.commitImportForSender(10, opened.token, 'merge');
    expect(committed.ok).toBe(true);
    const persisted = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'));
    expect(persisted['enso-settings'].state.theme).toBe('dark');
  });

  it('加密预览切换模式时复用 token 内已验证 bundle，不要求再次提交密码', async () => {
    const encrypted = join(userData, 'encrypted.enso-config');
    writeFileSync(
      encrypted,
      await encodeBundle(
        {
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
          secretsIncluded: true,
        },
        'correct horse'
      )
    );
    const opened = await service.openImportForSender(20, encrypted);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    await expect(
      service.previewImportForSender(20, opened.token, 'correct horse', 'merge')
    ).resolves.toMatchObject({ ok: true, mode: 'merge' });
    await expect(
      service.previewImportForSender(20, opened.token, undefined, 'replace')
    ).resolves.toMatchObject({ ok: true, mode: 'replace' });
  });

  it('错误密码返回固定安全错误键，不泄露解密异常', async () => {
    const encrypted = join(userData, 'wrong-password.enso-config');
    writeFileSync(
      encrypted,
      await encodeBundle(
        {
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
          secretsIncluded: true,
        },
        'correct horse'
      )
    );
    const opened = await service.openImportForSender(21, encrypted);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    await expect(
      service.previewImportForSender(21, opened.token, 'wrong password', 'merge')
    ).resolves.toEqual({
      ok: false,
      error: 'Incorrect password or damaged configuration package.',
    });
  });

  it('导出智能压缩设置并保留可重映射的模型引用', async () => {
    settings.patchSettingsState('providers', [
      {
        id: 'smart-provider',
        name: 'Smart Provider',
        api: 'openai-completions',
        apiKey: 'secret',
        baseUrl: 'https://example.test',
        enabled: true,
        models: [{ id: 'model-1' }],
      },
    ]);
    settings.patchSettingsState('smartCompactEnabled', true);
    settings.patchSettingsState('compactStrategy', 'continuous-memory');
    settings.patchSettingsState('smartCompactModel', {
      providerId: 'smart-provider',
      modelId: 'model-1',
    });
    const exported = join(userData, 'smart-compact.enso-config');
    expect(await service.exportConfigToPath({ includeSecrets: false }, exported)).toMatchObject({
      ok: true,
    });
    expect(statSync(exported).mode & 0o777).toBe(0o600);
    const decoded = await decodeBundle(readFileSync(exported));
    expect(decoded.state).toMatchObject({
      smartCompactEnabled: true,
      compactStrategy: 'continuous-memory',
      smartCompactModel: { providerId: 'smart-provider', modelId: 'model-1' },
    });
    settings.patchSettingsState('smartCompactEnabled', false);
    settings.patchSettingsState('compactStrategy', 'standard');
    settings.patchSettingsState('smartCompactModel', null);
  });

  it('导出拒绝覆盖符号链接且不修改链接目标', async () => {
    settings.patchSettingsState('skills', []);
    settings.patchSettingsState('instructions', []);
    const target = join(userData, 'export-target.txt');
    const link = join(userData, 'linked-export.enso-config');
    writeFileSync(target, 'keep-private-data');
    symlinkSync(target, link);

    await expect(
      service.exportConfigToPath({ includeSecrets: false }, link)
    ).resolves.toMatchObject({
      ok: false,
    });
    expect(readFileSync(target, 'utf8')).toBe('keep-private-data');
  });

  it('明文导出遇到技能或指令正文时要求改用加密导出', async () => {
    const skillPath = join(userData, 'plain-skill');
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(join(skillPath, 'SKILL.md'), '# private skill');
    settings.patchSettingsState('skills', [
      {
        id: 'plain-skill',
        name: 'Plain skill',
        description: '',
        path: skillPath,
        source: 'local',
        enabled: true,
      },
    ]);

    await expect(
      service.exportConfigToPath(
        { includeSecrets: false },
        join(userData, 'blocked-plain.enso-config')
      )
    ).resolves.toEqual({
      ok: false,
      error: 'Skill and instruction contents require an encrypted export.',
    });
    settings.patchSettingsState('skills', []);
  });

  it('包含敏感信息的导出在加密往返后保留 provider 与 MCP 凭证', async () => {
    settings.patchSettingsState('skills', []);
    settings.patchSettingsState('instructions', []);
    settings.patchSettingsState('providers', [
      {
        id: 'provider-secret',
        name: 'Secret Provider',
        api: 'openai-completions',
        apiKey: 'provider-key',
        baseUrl: 'https://example.test',
        enabled: true,
        models: [{ id: 'model-1' }],
      },
    ]);
    settings.patchSettingsState('mcpServers', [
      {
        id: 'mcp-secret',
        name: 'Secret MCP',
        transport: 'stdio',
        command: 'node',
        args: ['server.js', '--token', 'argument-secret'],
        env: { TOKEN: 'environment-secret' },
        source: 'local',
        enabled: true,
      },
    ]);
    const exported = join(userData, 'with-secrets.enso-config');
    const result = await service.exportConfigToPath(
      { includeSecrets: true, password: 'correct horse' },
      exported
    );
    expect(result.ok).toBe(true);

    const decoded = await decodeBundle(readFileSync(exported), 'correct horse');
    expect(decoded.state.providers[0]?.apiKey).toBe('provider-key');
    expect(decoded.state.mcpServers[0]?.args).toContain('argument-secret');
    expect(decoded.state.mcpServers[0]?.env).toEqual({ TOKEN: 'environment-secret' });
  });

  it('禁用或路径缺失的 skill 不阻断整包导出', async () => {
    const good = join(userData, 'good-skill');
    mkdirSync(good, { recursive: true });
    writeFileSync(join(good, 'SKILL.md'), '# good skill');
    settings.patchSettingsState('skills', [
      { id: 'good', name: 'Good', description: '', path: good, source: 'local', enabled: true },
      {
        id: 'gone',
        name: 'Gone',
        description: '',
        path: join(userData, 'missing-skill'),
        source: 'local',
        enabled: false,
      },
    ]);

    const exported = join(userData, 'tolerant-missing.enso-config');
    await expect(
      service.exportConfigToPath({ includeSecrets: true, password: 'correct horse' }, exported)
    ).resolves.toMatchObject({ ok: true });

    const decoded = await decodeBundle(readFileSync(exported), 'correct horse');
    expect(decoded.state.skills.map((skill) => skill.id)).toEqual(['good']);
    expect(decoded.resources.skills.map((resource) => resource.id)).toEqual(['good']);
    expect(decoded.state.providers.length).toBeGreaterThan(0);
  });

  it('symlink skill 被跳过，其余配置正常导出', async () => {
    const good = join(userData, 'good-skill-2');
    mkdirSync(good, { recursive: true });
    writeFileSync(join(good, 'SKILL.md'), '# good skill 2');
    const linked = join(userData, 'linked-skill');
    symlinkSync(good, linked);
    settings.patchSettingsState('skills', [
      { id: 'good2', name: 'Good2', description: '', path: good, source: 'local', enabled: true },
      {
        id: 'linked',
        name: 'Linked',
        description: '',
        path: linked,
        source: 'local',
        enabled: true,
      },
    ]);

    const exported = join(userData, 'tolerant-symlink.enso-config');
    await expect(
      service.exportConfigToPath({ includeSecrets: true, password: 'correct horse' }, exported)
    ).resolves.toMatchObject({ ok: true });

    const decoded = await decodeBundle(readFileSync(exported), 'correct horse');
    expect(decoded.state.skills.map((skill) => skill.id)).toEqual(['good2']);
    expect(decoded.resources.skills.map((resource) => resource.id)).toEqual(['good2']);
    settings.patchSettingsState('skills', []);
  });

  it('跳过的 skill 从 preset 引用中剔除且导出包可校验', async () => {
    const good = join(userData, 'good-skill-3');
    mkdirSync(good, { recursive: true });
    writeFileSync(join(good, 'SKILL.md'), '# good skill 3');
    settings.patchSettingsState('skills', [
      { id: 'good3', name: 'Good3', description: '', path: good, source: 'local', enabled: true },
      {
        id: 'gone3',
        name: 'Gone3',
        description: '',
        path: join(userData, 'missing-skill-3'),
        source: 'local',
        enabled: true,
      },
    ]);
    settings.patchSettingsState('presets', [
      { id: 'preset-1', name: 'Preset', skillIds: ['good3', 'gone3'], mcpServerIds: [] },
    ]);

    const exported = join(userData, 'pruned-skill-refs.enso-config');
    await expect(
      service.exportConfigToPath({ includeSecrets: true, password: 'correct horse' }, exported)
    ).resolves.toMatchObject({ ok: true });

    const decoded = validateBundle(await decodeBundle(readFileSync(exported), 'correct horse'));
    expect(decoded.state.presets[0]?.skillIds).toEqual(['good3']);
    settings.patchSettingsState('presets', []);
    settings.patchSettingsState('skills', []);
  });

  it('planImport 失败不得报成密码错误', async () => {
    settings.patchSettingsState('skills', []);
    settings.patchSettingsState('mcpServers', []);
    const shared = (id: string, name: string, baseUrl: string) => ({
      id,
      name,
      api: 'openai-completions',
      baseUrl,
      enabled: true,
      models: [{ id: 'model-1' }],
    });
    settings.patchSettingsState('providers', [
      shared('local-a', 'Shared', 'https://a.example.test'),
    ]);

    const file = join(userData, 'plan-failure.enso-config');
    writeFileSync(
      file,
      await encodeBundle(
        {
          format: 'enso-config',
          version: 1,
          createdAt: '2025-09-05T00:00:00.000Z',
          state: {
            providers: [shared('remote', 'Shared', 'https://remote.example.test')],
            skills: [],
            mcpServers: [],
            instructions: [],
            presets: [],
            agentTypes: [],
            subagentModels: [],
          },
          resources: { skills: [], instructions: [] },
          secretsIncluded: true,
        } as ConfigSyncBundle,
        'correct horse'
      )
    );

    const opened = await service.openImportForSender(40, file);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const preview = await service.previewImportForSender(
      40,
      opened.token,
      'correct horse',
      'merge'
    );
    expect(preview.ok).toBe(false);
    expect(preview).not.toMatchObject({
      error: 'Incorrect password or damaged configuration package.',
    });
  });

  it('四表锁步：SYNC_FIELDS / CONFIG_SYNC_COMMIT_FIELDS / STATE_KEYS / SCALAR_SETTING_KEYS', async () => {
    const { CONFIG_SYNC_COMMIT_FIELDS } = await import('../../ipc/settings');
    const listFrom = (file: string, name: string): string[] => {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      const body = source.split(`const ${name} = [`)[1]?.split(/\n\]/u)[0] ?? '';
      return [...body.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/gu)].map((match) => match[1]).sort();
    };
    const collections = [
      'providers',
      'skills',
      'mcpServers',
      'instructions',
      'presets',
      'agentTypes',
      'subagentModels',
    ];
    const sync = [...SYNC_FIELDS].sort();

    expect([...CONFIG_SYNC_COMMIT_FIELDS].sort()).toEqual(sync);
    expect(listFrom('src/main/services/configSync/codec.ts', 'STATE_KEYS')).toEqual(sync);
    expect(listFrom('src/main/services/configSync/merge.ts', 'SCALAR_SETTING_KEYS')).toEqual(
      sync.filter((field) => !collections.includes(field))
    );
  });
});
