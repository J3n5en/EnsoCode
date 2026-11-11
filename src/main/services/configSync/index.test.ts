import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const emptySecretsBundle = (): ConfigSyncBundle => ({
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
});
let emptyEncrypted: Buffer;

beforeAll(async () => {
  emptyEncrypted = await encodeBundle(emptySecretsBundle(), 'correct horse');
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

    const fieldsWithLegacy = [...persistedFields, 'hashlineEditEnabled'].sort();
    expect([...SETTINGS_STATE_FIELDS].sort()).toEqual(fieldsWithLegacy);
    expect(Object.keys(CONFIG_SYNC_FIELD_POLICY).sort()).toEqual(fieldsWithLegacy);
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
    writeFileSync(encrypted, emptyEncrypted);
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
    writeFileSync(encrypted, emptyEncrypted);
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

  it('强调色跟随主题时不进导出包，旧客户端导入不会因未知值整包失败', async () => {
    settings.patchSettingsState('skills', []);
    settings.patchSettingsState('accentColor', 'theme');
    const followTheme = join(userData, 'accent-theme.enso-config');
    expect(await service.exportConfigToPath({ includeSecrets: false }, followTheme)).toMatchObject({
      ok: true,
    });
    expect((await decodeBundle(readFileSync(followTheme))).state).not.toHaveProperty('accentColor');
    settings.patchSettingsState('accentColor', 'teal');
    expect(await service.exportConfigToPath({ includeSecrets: false }, followTheme)).toMatchObject({
      ok: true,
    });
    expect((await decodeBundle(readFileSync(followTheme))).state).toMatchObject({
      accentColor: 'teal',
    });
  });

  it('导出拒绝覆盖符号链接且不修改链接目标', async () => {
    settings.patchSettingsState('skills', []);
    settings.patchSettingsState('instructions', []);
    const target = join(userData, 'export-target.txt');
    const link = join(userData, 'linked-export.enso-config');
    writeFileSync(target, 'keep-private-data');
    symlinkSync(target, link);

    await expect(service.exportConfigToPath({ includeSecrets: false }, link)).resolves.toEqual({
      ok: false,
      error: 'The selected file is a symbolic link. Choose a different location.',
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
      error: 'Skill, instruction, and system prompt contents require an encrypted export.',
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

  it('源文件丢失的指令被跳过并报告，preset 引用随之剔除', async () => {
    settings.patchSettingsState('skills', []);
    const goodSource = join(userData, 'good-instruction.md');
    writeFileSync(goodSource, '# good instruction');
    settings.patchSettingsState('instructions', [
      {
        id: 'good-instruction',
        name: 'Good',
        source: 'Codex',
        sourcePath: goodSource,
        local: false,
        bytes: 1,
        enabled: true,
      },
      {
        id: 'gone-instruction',
        name: 'Gone',
        source: 'Codex',
        sourcePath: join(userData, 'deleted-project', 'AGENTS.md'),
        local: false,
        bytes: 1,
        enabled: true,
      },
    ]);
    settings.patchSettingsState('presets', [
      {
        id: 'keep',
        name: 'Keep',
        skillIds: [],
        mcpServerIds: [],
        instructionId: 'good-instruction',
      },
      {
        id: 'drop',
        name: 'Drop',
        skillIds: [],
        mcpServerIds: [],
        instructionId: 'gone-instruction',
      },
    ]);

    const exported = join(userData, 'skipped-instruction.enso-config');
    await expect(
      service.exportConfigToPath({ includeSecrets: true, password: 'correct horse' }, exported)
    ).resolves.toEqual({ ok: true, filePath: exported, skippedInstructions: ['Gone'] });

    const decoded = validateBundle(await decodeBundle(readFileSync(exported), 'correct horse'));
    expect(decoded.state.instructions.map((item) => item.id)).toEqual(['good-instruction']);
    expect(decoded.resources.instructions.map((item) => item.id)).toEqual(['good-instruction']);
    expect(decoded.state.presets.map((preset) => preset.instructionId)).toEqual([
      'good-instruction',
      undefined,
    ]);
    settings.patchSettingsState('presets', []);
    settings.patchSettingsState('instructions', []);
  });

  it('preset 引用的系统提示词缺失时给出具体原因', async () => {
    settings.patchSettingsState('skills', []);
    settings.patchSettingsState('instructions', []);
    settings.patchSettingsState('presets', [
      {
        id: 'prompt-preset',
        name: 'Prompt',
        skillIds: [],
        mcpServerIds: [],
        systemPromptId: '0f0f0f0f-1111-4222-8333-444444444444',
      },
    ]);

    await expect(
      service.exportConfigToPath(
        { includeSecrets: true, password: 'correct horse' },
        join(userData, 'missing-prompt.enso-config')
      )
    ).resolves.toEqual({
      ok: false,
      error: 'A preset uses a system prompt that is missing or empty.',
    });
    settings.patchSettingsState('presets', []);
  });

  it('目标位置无法写入时给出具体原因', async () => {
    settings.patchSettingsState('skills', []);
    settings.patchSettingsState('instructions', []);
    settings.patchSettingsState('presets', []);

    await expect(
      service.exportConfigToPath(
        { includeSecrets: false },
        join(userData, 'no-such-folder', 'out.enso-config')
      )
    ).resolves.toEqual({
      ok: false,
      error: 'Could not write the export file. Check that the folder is writable.',
    });
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
    expect(listFrom('src/main/services/configSync/codec.ts', 'STATE_KEYS')).toEqual(
      [...sync, 'hashlineEditEnabled', 'bashInterceptEnabled'].sort()
    );
    expect(listFrom('src/main/services/configSync/merge.ts', 'SCALAR_SETTING_KEYS')).toEqual(
      sync.filter((field) => !collections.includes(field))
    );
  });
});

describe('config sync preset system prompt resources', () => {
  const bundleWithSystemPrompt = (
    preset: { id: string; name: string; systemPromptId: string },
    content: string
  ): ConfigSyncBundle => ({
    format: 'enso-config',
    version: 1,
    createdAt: '2025-09-05T00:00:00.000Z',
    state: {
      providers: [],
      skills: [],
      mcpServers: [],
      instructions: [],
      presets: [{ ...preset, skillIds: [], mcpServerIds: [] }],
      agentTypes: [],
      subagentModels: [],
    },
    resources: {
      skills: [],
      instructions: [],
      systemPrompts: [{ id: preset.systemPromptId, content }],
    },
    secretsIncluded: true,
  });

  it('自定义预设正文经加密配置同步后仍由 UUID 引用恢复', async () => {
    const presetId = 'preset-system-prompt';
    const systemPromptId = '4aade2cb-d2a1-47c3-a4a2-848f28571a97';
    const content = 'portable custom system prompt';
    mkdirSync(join(userData, 'system-prompts'), { recursive: true });
    writeFileSync(join(userData, 'system-prompts', `${systemPromptId}.md`), content);
    settings.patchSettingsState('presets', [
      { id: presetId, name: 'Portable', skillIds: [], mcpServerIds: [], systemPromptId },
    ]);
    const file = join(userData, 'system-prompt.enso-config');
    try {
      await expect(
        service.exportConfigToPath({ includeSecrets: true, password: 'correct horse' }, file)
      ).resolves.toMatchObject({ ok: true });
      const decoded = await decodeBundle(readFileSync(file), 'correct horse');
      expect(decoded.resources.systemPrompts).toEqual([{ id: systemPromptId, content }]);

      rmSync(join(userData, 'system-prompts', `${systemPromptId}.md`));
      settings.patchSettingsState('presets', []);
      const opened = await service.openImportForSender(88, file);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      await expect(
        service.previewImportForSender(88, opened.token, 'correct horse', 'merge')
      ).resolves.toMatchObject({ ok: true });
      await expect(service.commitImportForSender(88, opened.token, 'merge')).resolves.toMatchObject(
        {
          ok: true,
        }
      );
      const persisted = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'));
      const importedPromptId = persisted['enso-settings'].state.presets[0].systemPromptId;
      expect(importedPromptId).not.toBe(systemPromptId);
      expect(readFileSync(join(userData, 'system-prompts', `${importedPromptId}.md`), 'utf8')).toBe(
        content
      );
    } finally {
      settings.patchSettingsState('presets', []);
      settings.flushSettings();
      rmSync(join(userData, 'system-prompts'), { recursive: true, force: true });
    }
  });

  it('merge 同源 UUID 历史分叉时不覆盖未导入的本机预设正文', async () => {
    const sharedPromptId = '11111111-1111-4111-8111-111111111111';
    const localContent = 'local divergent prompt';
    const importedContent = 'imported divergent prompt';
    const file = join(userData, 'system-prompt-conflict.enso-config');
    mkdirSync(join(userData, 'system-prompts'), { recursive: true });
    writeFileSync(join(userData, 'system-prompts', `${sharedPromptId}.md`), localContent);
    settings.patchSettingsState('presets', [
      {
        id: 'local-preset',
        name: 'Local preset',
        skillIds: [],
        mcpServerIds: [],
        systemPromptId: sharedPromptId,
      },
    ]);
    writeFileSync(
      file,
      await encodeBundle(
        bundleWithSystemPrompt(
          { id: 'imported-preset', name: 'Imported preset', systemPromptId: sharedPromptId },
          importedContent
        ),
        'correct horse'
      )
    );
    try {
      const opened = await service.openImportForSender(89, file);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      await expect(
        service.previewImportForSender(89, opened.token, 'correct horse', 'merge')
      ).resolves.toMatchObject({ ok: true });
      await expect(service.commitImportForSender(89, opened.token, 'merge')).resolves.toMatchObject(
        {
          ok: true,
        }
      );

      const persisted = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'));
      const presets = persisted['enso-settings'].state.presets as Array<{
        id: string;
        systemPromptId: string;
      }>;
      const local = presets.find((preset) => preset.id === 'local-preset');
      const imported = presets.find((preset) => preset.id === 'imported-preset');
      expect(local?.systemPromptId).toBe(sharedPromptId);
      expect(imported?.systemPromptId).not.toBe(sharedPromptId);
      expect(readFileSync(join(userData, 'system-prompts', `${sharedPromptId}.md`), 'utf8')).toBe(
        localContent
      );
      expect(
        readFileSync(join(userData, 'system-prompts', `${imported?.systemPromptId}.md`), 'utf8')
      ).toBe(importedContent);
    } finally {
      settings.patchSettingsState('presets', []);
      settings.flushSettings();
      rmSync(join(userData, 'system-prompts'), { recursive: true, force: true });
      rmSync(file, { force: true });
    }
  });

  it('replace 为导入正文生成新 UUID，并保留备份仍可能引用的旧正文', async () => {
    const oldPromptId = '22222222-2222-4222-8222-222222222222';
    const sourcePromptId = '33333333-3333-4333-8333-333333333333';
    const file = join(userData, 'system-prompt-replace.enso-config');
    mkdirSync(join(userData, 'system-prompts'), { recursive: true });
    writeFileSync(join(userData, 'system-prompts', `${oldPromptId}.md`), 'removed local prompt');
    settings.patchSettingsState('presets', [
      {
        id: 'removed-local-preset',
        name: 'Removed local preset',
        skillIds: [],
        mcpServerIds: [],
        systemPromptId: oldPromptId,
      },
    ]);
    writeFileSync(
      file,
      await encodeBundle(
        bundleWithSystemPrompt(
          { id: 'replacement-preset', name: 'Replacement', systemPromptId: sourcePromptId },
          'replacement prompt'
        ),
        'correct horse'
      )
    );
    try {
      const opened = await service.openImportForSender(90, file);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      await expect(
        service.previewImportForSender(90, opened.token, 'correct horse', 'replace')
      ).resolves.toMatchObject({ ok: true });
      await expect(
        service.commitImportForSender(90, opened.token, 'replace')
      ).resolves.toMatchObject({ ok: true });

      const persisted = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'));
      const importedPromptId = persisted['enso-settings'].state.presets[0].systemPromptId;
      expect(importedPromptId).not.toBe(sourcePromptId);
      expect(existsSync(join(userData, 'system-prompts', `${oldPromptId}.md`))).toBe(true);
      expect(readFileSync(join(userData, 'system-prompts', `${importedPromptId}.md`), 'utf8')).toBe(
        'replacement prompt'
      );
    } finally {
      settings.patchSettingsState('presets', []);
      settings.flushSettings();
      rmSync(join(userData, 'system-prompts'), { recursive: true, force: true });
      rmSync(file, { force: true });
    }
  });

  it('预览后设置发生变化导致提交失败时回滚新生成的正文文件', async () => {
    const sourcePromptId = '44444444-4444-4444-8444-444444444444';
    const file = join(userData, 'system-prompt-rollback.enso-config');
    rmSync(join(userData, 'system-prompts'), { recursive: true, force: true });
    settings.patchSettingsState('presets', []);
    settings.patchSettingsState('theme', 'dark');
    writeFileSync(
      file,
      await encodeBundle(
        bundleWithSystemPrompt(
          { id: 'rollback-preset', name: 'Rollback', systemPromptId: sourcePromptId },
          'must be rolled back'
        ),
        'correct horse'
      )
    );
    try {
      const opened = await service.openImportForSender(91, file);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      await expect(
        service.previewImportForSender(91, opened.token, 'correct horse', 'merge')
      ).resolves.toMatchObject({ ok: true });
      settings.patchSettingsState('theme', 'light');

      await expect(service.commitImportForSender(91, opened.token, 'merge')).resolves.toMatchObject(
        {
          ok: false,
        }
      );
      expect(existsSync(join(userData, 'system-prompts'))).toBe(true);
      expect(readdirSync(join(userData, 'system-prompts'))).toEqual([]);
      expect(
        JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))['enso-settings'].state
          .presets
      ).toEqual([]);
    } finally {
      settings.patchSettingsState('presets', []);
      settings.patchSettingsState('theme', 'dark');
      settings.flushSettings();
      rmSync(join(userData, 'system-prompts'), { recursive: true, force: true });
      rmSync(file, { force: true });
    }
  });
});
