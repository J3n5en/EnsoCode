import { describe, expect, it } from 'vitest';
import { applyPluginPresetOverrides } from './agentHost';

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
