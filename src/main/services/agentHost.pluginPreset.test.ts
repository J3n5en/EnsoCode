import { presetOverlay } from '@shared/extensionPlugins/preset';
import { describe, expect, it } from 'vitest';
import {
  applyPluginPresetOverrides,
  mergePresetPromptKit,
  pluginPresetInstruction,
  pluginSkillPathsForMenu,
} from './agentHost';

const resolveModel = (model: { providerId: string; modelId: string }) =>
  model.modelId === 'missing'
    ? { ok: false as const, error: 'Model is unavailable: model-missing' }
    : { ok: true as const, model: { modelId: model.modelId } };

describe('applyPluginPresetOverrides', () => {
  it('无预设时保持请求', () => {
    expect(
      applyPluginPresetOverrides({
        model: { modelId: 'base' },
        thinkingLevel: 'low',
        approvalMode: 'full',
        disabledTools: ['bash'],
        resolveModel,
      })
    ).toEqual({
      ok: true,
      model: { modelId: 'base' },
      thinkingLevel: 'low',
      approvalMode: 'full',
      disabledTools: ['bash'],
    });
  });

  it('预设模型不可用则拒绝启动', () => {
    expect(
      applyPluginPresetOverrides({
        model: { modelId: 'base' },
        disabledTools: [],
        preset: { model: { providerId: 'p', modelId: 'missing' } },
        resolveModel,
      })
    ).toEqual({ ok: false, error: 'Model is unavailable: model-missing' });
  });

  it('模型、思考档以预设为准，审批取更严，禁用工具并入', () => {
    expect(
      applyPluginPresetOverrides({
        model: { modelId: 'base' },
        thinkingLevel: 'low',
        approvalMode: 'assistant',
        disabledTools: ['bash'],
        preset: {
          model: { providerId: 'p', modelId: 'preset' },
          thinkingLevel: 'high',
          approvalMode: 'auto-edits',
          disabledTools: ['bash', 'web'],
        },
        resolveModel,
      })
    ).toEqual({
      ok: true,
      model: { modelId: 'preset' },
      thinkingLevel: 'high',
      approvalMode: 'auto-edits',
      disabledTools: ['bash', 'web'],
    });
  });

  it('已经更严的审批不被预设放宽，未指定时采用预设', () => {
    expect(
      applyPluginPresetOverrides({
        model: { modelId: 'base' },
        approvalMode: 'supervised',
        disabledTools: [],
        preset: { approvalMode: 'auto-edits' },
        resolveModel,
      })
    ).toMatchObject({ ok: true, approvalMode: 'supervised' });
    expect(
      applyPluginPresetOverrides({
        model: { modelId: 'base' },
        disabledTools: [],
        preset: { approvalMode: 'supervised' },
        resolveModel,
      })
    ).toMatchObject({ ok: true, approvalMode: 'supervised' });
  });
});

describe('pluginPresetInstruction', () => {
  const global = { path: '/g.md', content: 'global' };

  it('预设没带指令时沿用全局指令', () => {
    expect(pluginPresetInstruction(undefined, () => global)).toEqual(global);
  });

  it('预设带指令时替换全局指令', () => {
    const own = { path: '/p.md', content: 'preset' };
    expect(pluginPresetInstruction(own, () => global)).toEqual(own);
  });
});

describe('mergePresetPromptKit', () => {
  it('没有叠加插件预设时保持自建预设', () => {
    const own = { systemPrompt: 'role', systemPromptAppend: 'tail' };
    expect(mergePresetPromptKit(own)).toEqual(own);
  });

  it('尾段自建在前、插件在后拼接；角色、加强、推脱补发以插件为准，插件没有则沿用自建', () => {
    expect(
      mergePresetPromptKit(
        {
          systemPrompt: 'own role',
          systemPromptAppend: 'own tail',
          systemPromptBoost: 'own boost',
          refusalRetryPrompt: 'own retry',
        },
        { systemPromptAppend: 'plugin tail', systemPromptBoost: 'plugin boost' }
      )
    ).toEqual({
      systemPrompt: 'own role',
      systemPromptAppend: 'own tail\n\nplugin tail',
      systemPromptBoost: 'plugin boost',
      refusalRetryPrompt: 'own retry',
    });
    expect(mergePresetPromptKit({}, { systemPrompt: 'p', systemPromptAppend: 't' })).toEqual({
      systemPrompt: 'p',
      systemPromptAppend: 't',
    });
  });
});

describe('presetOverlay', () => {
  const user = {
    id: 'u',
    name: 'U',
    skillIds: [],
    mcpServerIds: [],
    pluginPresetId: 'plugin:enso.pstack:poteto',
  };

  it('直接选插件预设：插件预设本身，无自建预设', () => {
    expect(presetOverlay('plugin:enso.pstack:poteto', () => user)).toEqual({
      pluginPresetId: 'plugin:enso.pstack:poteto',
      required: true,
    });
  });

  it('自建预设叠加插件预设：可选叠加，失效时不阻断', () => {
    expect(presetOverlay('u', () => user)).toEqual({
      preset: user,
      pluginPresetId: 'plugin:enso.pstack:poteto',
      required: false,
    });
  });

  it('自建预设未叠加或字段非法时不带插件预设', () => {
    const plain = { ...user, pluginPresetId: undefined };
    expect(presetOverlay('u', () => plain)).toEqual({ preset: plain, required: false });
    expect(presetOverlay('u', () => ({ ...user, pluginPresetId: 'not-plugin' }))).toEqual({
      preset: { ...user, pluginPresetId: 'not-plugin' },
      required: false,
    });
  });
});

describe('pluginSkillPathsForMenu', () => {
  const user = {
    id: 'u',
    name: 'U',
    skillIds: [],
    mcpServerIds: [],
    pluginPresetId: 'plugin:enso.pstack:poteto',
  };
  const extension = (ok: boolean) => ({
    presetForSpawn: (id?: string) =>
      id ? (ok ? { ok: true as const } : { ok: false as const, error: 'x' }) : undefined,
    skillPathsForSpawn: (active?: string) => (active ? ['/p/always', '/p/scoped'] : ['/p/always']),
  });

  it('选中插件预设（直接或经自建预设叠加）时含它圈定的 skill，Claude 插件在前', () => {
    for (const presetId of ['plugin:enso.pstack:poteto', 'u']) {
      expect(
        pluginSkillPathsForMenu(presetId, {
          resolve: () => user,
          claude: ['/c'],
          extension: extension(true),
        })
      ).toEqual(['/c', '/p/always', '/p/scoped']);
    }
  });

  it('没选插件预设或插件预设失效时只含不受预设圈定的 skill', () => {
    expect(
      pluginSkillPathsForMenu(undefined, {
        resolve: () => undefined,
        claude: [],
        extension: extension(true),
      })
    ).toEqual(['/p/always']);
    expect(
      pluginSkillPathsForMenu('u', { resolve: () => user, claude: [], extension: extension(false) })
    ).toEqual(['/p/always']);
    expect(
      pluginSkillPathsForMenu('u', { resolve: () => user, claude: ['/c'], extension: null })
    ).toEqual(['/c']);
  });
});
