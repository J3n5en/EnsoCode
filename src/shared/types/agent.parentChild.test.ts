import { describe, expect, it } from 'vitest';
import { resolveShellLimits } from '../shellLimits';
import { parseAgentCommand, parseAgentWorkerEvent, parseChildConversationMetadata } from './agent';
import {
  child,
  legacyEnsoChild,
  model,
  PARENT_GENERATION,
  parent,
  proof,
  receipt,
  SPAWN_SPEC_ID,
  task,
} from './agent.testUtils';

describe('parent/child commands', () => {
  it('set-builtin-tools：父会话身份 + 工具 id 列表，脏值拒绝', () => {
    const command = { type: 'set-builtin-tools', identity: parent, disabledTools: ['memory'] };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, disabledTools: [] })).toEqual({
      ...command,
      disabledTools: [],
    });
    expect(parseAgentCommand({ ...command, disabledTools: 'memory' })).toBeNull();
    expect(parseAgentCommand({ ...command, disabledTools: [1] })).toBeNull();
    expect(parseAgentCommand({ ...command, disabledTools: ['x'.repeat(200)] })).toBeNull();
    expect(parseAgentCommand({ ...command, extra: true })).toBeNull();
    expect(parseAgentCommand({ ...command, identity: { sessionId: 'conversation-1' } })).toBeNull();
  });

  it('rewind accepts an exclusive persisted entry anchor and rejects ambiguous or dirty anchors', () => {
    const command = { type: 'rewind', identity: parent, entryId: 'user-entry', restoreFiles: true };
    expect(parseAgentCommand(command)).toEqual(command);
    for (const entryId of ['', ' ', 1, null]) {
      expect(parseAgentCommand({ ...command, entryId })).toBeNull();
    }
    expect(parseAgentCommand({ ...command, userIndexFromEnd: 0 })).toBeNull();
    expect(parseAgentCommand({ ...command, userIndexFromEnd: '0' })).toBeNull();
    expect(parseAgentCommand({ type: 'rewind', identity: parent })).toBeNull();
    expect(
      parseAgentCommand({ type: 'rewind', identity: parent, userIndexFromEnd: 0 })
    ).not.toBeNull();
  });
  it('spawn-parent 必须 exact generation；旧 spawn/sessionId shape 拒绝', () => {
    const command = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({ ...command, identity: { ...parent, generation: 'old' } })
    ).toBeNull();
    expect(
      parseAgentCommand({ type: 'spawn', sessionId: parent.sessionId, cwd: '/repo', model })
    ).toBeNull();
  });

  // spawn-parent 的可选标量字段：合法值原样透传，脏值整条拒绝；不带字段的旧会话由上一条覆盖
  const spawnFieldCases: Array<[field: string, valid: unknown[], invalid: unknown[]]> = [
    ['rolePrompt', ['You are aside'], ['', 1]],
    [
      'trustedProjectCode',
      [['.pi/extensions/a.ts', 'package:npm:x']],
      ['x', [1], ['x'.repeat(2000)]],
    ],
    ['workflowPresetFiles', [['/plugins/demo/workflows/triage.js']], ['x', ['']]],
    ['editMode', ['replace', 'apply_patch'], ['patch', true]],
    ['hashlineEditEnabled', [true, false], ['true', 1]],
    ['compactStrategy', ['standard', 'smart', 'continuous-memory'], ['plugin', true]],
    ['smartCompactEnabled', [true, false], ['true', 1]],
    ['smartCompactSummaryModel', [model], [{ modelId: 'gpt' }, 'anthropic/x']],
    ['smartCompactMode', ['balanced', 'fast', 'thorough', 'auto'], ['aggressive', true]],
    ['windowsLocalShell', ['bash', 'auto', 'powershell'], ['pwsh', true]],
    ['rtkEnabled', [true, false], [0, 'false', null, {}]],
  ];
  it.each(spawnFieldCases)('spawn-parent 携 %s：合法值透传，脏值拒绝', (field, valid, invalid) => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    for (const value of valid) {
      expect(parseAgentCommand({ ...base, [field]: value })).toEqual({ ...base, [field]: value });
    }
    for (const value of invalid) {
      expect(parseAgentCommand({ ...base, [field]: value })).toBeNull();
    }
  });

  it('spawn-parent 携 botDiscussMode：只接受布尔值，true 只能出现在 Bot 群聊成员会话', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    const group = { ...base, botMode: true, botGroupTasks: true };
    expect(parseAgentCommand({ ...group, botDiscussMode: true })).toEqual({
      ...group,
      botDiscussMode: true,
    });
    expect(parseAgentCommand({ ...group, botDiscussMode: false })).toEqual({
      ...group,
      botDiscussMode: false,
    });
    expect(parseAgentCommand({ ...base, botDiscussMode: false })).toEqual({
      ...base,
      botDiscussMode: false,
    });
    for (const value of ['true', 1, null, {}])
      expect(parseAgentCommand({ ...group, botDiscussMode: value })).toBeNull();
    // 私聊 / 非 Bot 会话没有群聊讨论：带 true 视为坏命令
    expect(parseAgentCommand({ ...base, botDiscussMode: true })).toBeNull();
    expect(parseAgentCommand({ ...base, botMode: true, botDiscussMode: true })).toBeNull();
    expect(parseAgentCommand({ ...base, botGroupTasks: true, botDiscussMode: true })).toBeNull();
  });

  it('阶段13：spawn-parent / prompt / steer / retry 可带实例号，只收 UUID，prompt/steer/retry 只对父会话', () => {
    const instanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const commands = [
      { type: 'spawn-parent', identity: parent, cwd: '/repo', model },
      { type: 'prompt', identity: parent, text: 'hi' },
      { type: 'steer', identity: parent, text: 'hi' },
      { type: 'retry', identity: parent },
    ];
    for (const command of commands) {
      expect(parseAgentCommand(command)).toEqual(command);
      expect(parseAgentCommand({ ...command, instanceId })).toEqual({ ...command, instanceId });
      for (const bad of ['', 'not-a-uuid', 1, null, {}])
        expect(parseAgentCommand({ ...command, instanceId: bad })).toBeNull();
    }
    for (const type of ['prompt', 'steer'])
      expect(parseAgentCommand({ type, identity: child, text: 'hi', instanceId })).toBeNull();
    expect(parseAgentCommand({ type: 'retry', identity: child, instanceId })).toBeNull();
    expect(parseAgentCommand({ type: 'retry', identity: parent, instanceId, extra: 1 })).toBeNull();
    // 不在归属范围内的命令不接受实例号
    for (const type of ['abort', 'abort-retry', 'release-parent'])
      expect(parseAgentCommand({ type, identity: parent, instanceId })).toBeNull();
  });

  it('spawn-parent 携插件命令与 hooks:合法通过,脏值拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    const hook = {
      plugin: 'demo',
      root: '/p',
      dataDir: '/d',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'echo hi',
      timeoutSec: 5,
    };
    const command = {
      name: 'demo:review',
      description: 'Review',
      argumentHint: '[focus]',
      content: 'Review $ARGUMENTS',
      filePath: '/p/commands/review.md',
    };
    const full = { ...base, pluginHooks: [hook], pluginCommands: [command] };
    expect(parseAgentCommand(full)).toEqual(full);
    expect(
      parseAgentCommand({ ...base, pluginHooks: [{ ...hook, event: 'Notification' }] })
    ).toBeNull();
    expect(parseAgentCommand({ ...base, pluginHooks: [{ ...hook, timeoutSec: 0 }] })).toBeNull();
    expect(parseAgentCommand({ ...base, pluginHooks: [{ ...hook, extra: 1 }] })).toBeNull();
    expect(
      parseAgentCommand({ ...base, pluginCommands: [{ ...command, content: '' }] })
    ).toBeNull();
    expect(parseAgentCommand({ ...base, pluginCommands: 'x' })).toBeNull();
  });

  it('tool-background 必须 exact identity + 合法 toolCallId', () => {
    const command = { type: 'tool-background', identity: parent, toolCallId: 'call_1|fc_2' };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({ ...command, identity: { ...parent, generation: 'old' } })
    ).toBeNull();
    expect(parseAgentCommand({ ...command, toolCallId: '' })).toBeNull();
    expect(parseAgentCommand({ ...command, toolCallId: 'x'.repeat(513) })).toBeNull();
    expect(parseAgentCommand({ ...command, extra: 1 })).toBeNull();
  });

  it('workflow-stop 必须 exact identity + 合法 runId', () => {
    const command = { type: 'workflow-stop', identity: parent, runId: 'run-1' };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({ ...command, identity: { ...parent, generation: 'old' } })
    ).toBeNull();
    expect(parseAgentCommand({ ...command, runId: '' })).toBeNull();
    expect(parseAgentCommand({ ...command, runId: 'x'.repeat(81) })).toBeNull();
    expect(parseAgentCommand({ ...command, extra: 1 })).toBeNull();
  });

  it('subagent-stop 必须 exact identity + 非空 agentId', () => {
    const command = { type: 'subagent-stop', identity: parent, agentId: 'agent-1' };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({ ...command, identity: { ...parent, generation: 'old' } })
    ).toBeNull();
    expect(parseAgentCommand({ type: 'subagent-stop', identity: parent, agentId: '' })).toBeNull();
    expect(
      parseAgentCommand({ type: 'subagent-stop', sessionId: parent.sessionId, agentId: 'agent-1' })
    ).toBeNull();
  });

  it('set-max-active-coworkers 只接受 1–20 整数', () => {
    expect(parseAgentCommand({ type: 'set-max-active-coworkers', limit: 5 })).toEqual({
      type: 'set-max-active-coworkers',
      limit: 5,
    });
    expect(parseAgentCommand({ type: 'set-max-active-coworkers', limit: 1 })).not.toBeNull();
    expect(parseAgentCommand({ type: 'set-max-active-coworkers', limit: 20 })).not.toBeNull();
    expect(parseAgentCommand({ type: 'set-max-active-coworkers', limit: 0 })).toBeNull();
    expect(parseAgentCommand({ type: 'set-max-active-coworkers', limit: 21 })).toBeNull();
    expect(parseAgentCommand({ type: 'set-max-active-coworkers', limit: 5.5 })).toBeNull();
    expect(parseAgentCommand({ type: 'set-max-active-coworkers' })).toBeNull();
  });

  it('set-shell-limits 只接受 resolveShellLimits 规范化后的完整值', () => {
    const limits = resolveShellLimits({ taskWaitMaxMs: 5000 });
    expect(parseAgentCommand({ type: 'set-shell-limits', limits })).toEqual({
      type: 'set-shell-limits',
      limits,
    });
    expect(
      parseAgentCommand({ type: 'set-shell-limits', limits: { ...limits, taskWaitMaxMs: -1 } })
    ).toBeNull();
    expect(
      parseAgentCommand({ type: 'set-shell-limits', limits: { taskWaitMaxMs: 5000 } })
    ).toBeNull();
    expect(parseAgentCommand({ type: 'set-shell-limits', limits: null })).toBeNull();
    expect(parseAgentCommand({ type: 'set-shell-limits', limits, extra: 1 })).toBeNull();
  });

  it('set-auto-retry-limit 接受 -1（无限）到 100 的整数', () => {
    expect(parseAgentCommand({ type: 'set-auto-retry-limit', limit: -1 })).toEqual({
      type: 'set-auto-retry-limit',
      limit: -1,
    });
    expect(parseAgentCommand({ type: 'set-auto-retry-limit', limit: 0 })).not.toBeNull();
    expect(parseAgentCommand({ type: 'set-auto-retry-limit', limit: 101 })).toBeNull();
    expect(parseAgentCommand({ type: 'set-auto-retry-limit', limit: 1.5 })).toBeNull();
    expect(parseAgentCommand({ type: 'set-auto-retry-limit' })).toBeNull();
  });

  it('set-disabled-workflow-presets 只接受合法 id 数组', () => {
    expect(
      parseAgentCommand({ type: 'set-disabled-workflow-presets', ids: ['parallel-review'] })
    ).toEqual({ type: 'set-disabled-workflow-presets', ids: ['parallel-review'] });
    expect(parseAgentCommand({ type: 'set-disabled-workflow-presets', ids: [] })).not.toBeNull();
    expect(parseAgentCommand({ type: 'set-disabled-workflow-presets', ids: ['../x'] })).toBeNull();
    expect(parseAgentCommand({ type: 'set-disabled-workflow-presets', ids: 'x' })).toBeNull();
    expect(parseAgentCommand({ type: 'set-disabled-workflow-presets' })).toBeNull();
  });

  it('set-model-directory 只校验键，载荷留给 worker 收窄', () => {
    const command = {
      type: 'set-model-directory',
      snapshot: { revision: 1 },
      customProviders: [],
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ type: 'set-model-directory', snapshot: null })).toBeNull();
    expect(
      parseAgentCommand({
        type: 'set-model-directory',
        snapshot: null,
        customProviders: [],
        extra: 1,
      })
    ).toBeNull();
  });

  it('set-compact-route 接受最新摘要模型，缺省表示改跟会话模型', () => {
    expect(parseAgentCommand({ type: 'set-compact-route', model, mode: 'fast' })).toEqual({
      type: 'set-compact-route',
      model,
      mode: 'fast',
    });
    expect(parseAgentCommand({ type: 'set-compact-route' })).toEqual({ type: 'set-compact-route' });
    expect(parseAgentCommand({ type: 'set-compact-route', model: { modelId: 'gpt' } })).toBeNull();
    expect(parseAgentCommand({ type: 'set-compact-route', mode: 'plugin' })).toBeNull();
  });

  it('spawn-parent / set-model 携虚拟模型配置：成员与分类器严格收窄', () => {
    const virtualModel = {
      ...model,
      settingsProviderId: 'enso-virtual',
      modelId: 'auto-1',
      virtual: {
        name: 'Auto',
        primary: model,
        fast: { ...model, modelId: 'fast' },
        fallbacks: [{ ...model, modelId: 'backup' }],
        classifier: { source: 'judge', timeoutMs: 3000, model: { ...model, modelId: 'fast' } },
      },
    };
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo' };
    expect(parseAgentCommand({ ...base, model: virtualModel })).toEqual({
      ...base,
      model: virtualModel,
    });
    expect(
      parseAgentCommand({ type: 'set-model', identity: parent, model: virtualModel })
    ).not.toBeNull();
    const piClassifier = {
      ...virtualModel,
      virtual: {
        ...virtualModel.virtual,
        classifier: {
          source: 'pi-classifier',
          timeoutMs: 3000,
          classifier: { provider: 'openrouter', modelId: 'typesafe/jev-1.13', apiKey: 'k' },
        },
      },
    };
    expect(parseAgentCommand({ ...base, model: piClassifier })).not.toBeNull();
    const bad = [
      { ...virtualModel, virtual: { ...virtualModel.virtual, primary: { modelId: 'x' } } },
      { ...virtualModel, virtual: { ...virtualModel.virtual, fallbacks: [virtualModel] } },
      { ...virtualModel, virtual: { ...virtualModel.virtual, extra: true } },
      {
        ...virtualModel,
        virtual: { ...virtualModel.virtual, classifier: { source: 'judge', timeoutMs: 3000 } },
      },
      {
        ...virtualModel,
        virtual: {
          ...virtualModel.virtual,
          classifier: {
            source: 'pi-classifier',
            timeoutMs: 0,
            classifier: { provider: 'x', modelId: 'y' },
          },
        },
      },
    ];
    for (const candidate of bad) {
      expect(parseAgentCommand({ ...base, model: candidate })).toBeNull();
    }
    // 辅助用途（代审、压缩摘要）只收真实模型
    expect(parseAgentCommand({ type: 'set-approval-reviewer', model: virtualModel })).toBeNull();
    // 代审可改用分类器；与 model 互斥，凭证字段严格校验
    const classifier = { provider: 'typesafe', modelId: 'jev-latest', apiKey: 'k' };
    expect(parseAgentCommand({ type: 'set-approval-reviewer', classifier })).toEqual({
      type: 'set-approval-reviewer',
      classifier,
    });
    expect(parseAgentCommand({ type: 'set-approval-reviewer', model, classifier })).toBeNull();
    expect(
      parseAgentCommand({ type: 'set-approval-reviewer', classifier: { ...classifier, x: 1 } })
    ).toBeNull();
    expect(parseAgentCommand({ ...base, model, approvalReviewerClassifier: classifier })).toEqual({
      ...base,
      model,
      approvalReviewerClassifier: classifier,
    });
    expect(
      parseAgentCommand({
        ...base,
        model,
        approvalReviewer: model,
        approvalReviewerClassifier: classifier,
      })
    ).toBeNull();
    expect(
      parseAgentCommand({ ...base, model, approvalReviewerClassifier: { provider: '' } })
    ).toBeNull();
    // 托管只随分类器下发
    expect(parseAgentCommand({ type: 'set-approval-reviewer', classifier, managed: true })).toEqual(
      { type: 'set-approval-reviewer', classifier, managed: true }
    );
    expect(parseAgentCommand({ type: 'set-approval-reviewer', model, managed: true })).toBeNull();
    expect(
      parseAgentCommand({ type: 'set-approval-reviewer', classifier, managed: 'yes' })
    ).toBeNull();
    expect(
      parseAgentCommand({
        ...base,
        model,
        approvalReviewerClassifier: classifier,
        approvalReviewerManaged: true,
      })
    ).toMatchObject({ approvalReviewerManaged: true });
    expect(
      parseAgentCommand({ ...base, model, approvalReviewer: model, approvalReviewerManaged: true })
    ).toBeNull();
    // 放行阈值只随分类器下发，只认三档
    expect(
      parseAgentCommand({
        ...base,
        model,
        approvalReviewerClassifier: classifier,
        approvalReviewerAllowThreshold: 0.85,
      })
    ).toMatchObject({ approvalReviewerAllowThreshold: 0.85 });
    for (const bad of [0.5, '0.85']) {
      expect(
        parseAgentCommand({
          ...base,
          model,
          approvalReviewerClassifier: classifier,
          approvalReviewerAllowThreshold: bad,
        })
      ).toBeNull();
    }
    expect(
      parseAgentCommand({
        ...base,
        model,
        approvalReviewer: model,
        approvalReviewerAllowThreshold: 0.95,
      })
    ).toBeNull();
    expect(
      parseAgentCommand({ type: 'set-approval-reviewer', classifier, allowThreshold: 0.95 })
    ).toEqual({ type: 'set-approval-reviewer', classifier, allowThreshold: 0.95 });
    expect(
      parseAgentCommand({ type: 'set-approval-reviewer', classifier, allowThreshold: 0.7 })
    ).toBeNull();
    expect(
      parseAgentCommand({ type: 'set-approval-reviewer', model, allowThreshold: 0.95 })
    ).toBeNull();
    expect(
      parseAgentCommand({ ...base, model, smartCompactSummaryModel: virtualModel })
    ).toBeNull();
  });

  it('命令结果统计在 worker 边界校验，非法计数拒绝', () => {
    const event = {
      type: 'message-upsert',
      identity: parent,
      seq: 1,
      index: 0,
      message: {
        role: 'toolResult',
        toolName: 'bash',
        content: [],
        rtk: {
          status: 'compressed',
          originalCommand: 'git status',
          inputTokens: 100,
          outputTokens: 10,
        },
      },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(
      parseAgentWorkerEvent({
        ...event,
        message: { ...event.message, rtk: { ...event.message.rtk, inputTokens: -10 } },
      })
    ).toBeNull();
    const moved = { ...event, message: { ...event.message, backgroundTaskId: 'task-1-abc' } };
    expect(parseAgentWorkerEvent(moved)).toEqual(moved);
    const failed = {
      ...event,
      message: { ...event.message, shellFailure: { kind: 'auth_required', retryable: false } },
    };
    expect(parseAgentWorkerEvent(failed)).toEqual(failed);
    expect(
      parseAgentWorkerEvent({
        ...event,
        message: { ...event.message, shellFailure: { kind: 'nope', retryable: false } },
      })
    ).toBeNull();
    const reviewed = {
      ...event,
      message: {
        ...event.message,
        approvalReview: { verdict: 'allow', model: 'jev', allow: 0.95, ask: 0.05, block: 0 },
      },
    };
    expect(parseAgentWorkerEvent(reviewed)).toEqual(reviewed);
    expect(
      parseAgentWorkerEvent({
        ...event,
        message: { ...event.message, approvalReview: { verdict: 'allow' } },
      })
    ).toBeNull();
    const request = {
      type: 'approval-request',
      identity: parent,
      seq: 1,
      request: { requestId: 'r', tool: 'bash', kind: 'command', summary: 'ls' },
    };
    for (const reviewFallback of ['timeout', 'error', 'invalid']) {
      const withFallback = { ...request, request: { ...request.request, reviewFallback } };
      expect(parseAgentWorkerEvent(withFallback)).toEqual(withFallback);
    }
    expect(
      parseAgentWorkerEvent({ ...request, request: { ...request.request, reviewFallback: 'x' } })
    ).toBeNull();
    for (const backgroundTaskId of ['', 1, 'x'.repeat(129)]) {
      expect(
        parseAgentWorkerEvent({ ...event, message: { ...event.message, backgroundTaskId } })
      ).toBeNull();
    }
  });

  it('spawn-parent 携 remote:合法通过,坏 shape 拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/srv/app', model };
    const withRemote = { ...base, remote: { host: 'user@dev-box', auth: 'key' } };
    expect(parseAgentCommand(withRemote)).toEqual(withRemote);
    expect(parseAgentCommand({ ...base, remote: { host: 'user@dev-box' } })).toBeNull();
    expect(parseAgentCommand({ ...base, remote: { host: '', auth: 'key' } })).toBeNull();
    expect(parseAgentCommand({ ...base, remote: {} })).toBeNull();
    expect(parseAgentCommand({ ...base, remote: 'user@dev-box' })).toBeNull();
    const withPort = { ...base, remote: { host: 'h', auth: 'key', port: 22 } };
    expect(parseAgentCommand(withPort)).toEqual(withPort);
    const withPassword = {
      ...base,
      remote: { host: 'h', auth: 'password', password: 's3cret' },
    };
    expect(parseAgentCommand(withPassword)).toEqual(withPassword);
    expect(parseAgentCommand({ ...base, remote: { host: 'h', auth: 'password' } })).toBeNull();
    expect(
      parseAgentCommand({
        ...base,
        remote: { host: 'h', auth: 'key', password: 'nope' },
      })
    ).toBeNull();
    const withTimeout = { ...base, remote: { host: 'h', auth: 'key', timeoutSeconds: 60 } };
    expect(parseAgentCommand(withTimeout)).toEqual(withTimeout);
    for (const timeoutSeconds of [0, 12.5, '60']) {
      expect(
        parseAgentCommand({ ...base, remote: { host: 'h', auth: 'key', timeoutSeconds } })
      ).toBeNull();
    }
  });

  it('release-parent 可解析（Move to worktree 依赖；漏白名单会被 worker 静默丢弃）', () => {
    const command = { type: 'release-parent', identity: parent };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ type: 'release-parent' })).toBeNull();
  });

  it('spawn-parent 携 subagentModels:合法通过,坏条目整条拒绝', () => {
    const option = { name: 'openai/gpt', config: model, description: '便宜快,适合简单任务' };
    const command = {
      type: 'spawn-parent',
      identity: parent,
      cwd: '/repo',
      model,
      subagentModels: [option],
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({ ...command, subagentModels: [{ name: '', config: model }] })
    ).toBeNull();
    expect(parseAgentCommand({ ...command, subagentModels: [{ name: 'x' }] })).toBeNull();
    expect(
      parseAgentCommand({
        ...command,
        subagentModels: [{ name: 'x', config: model, description: 42 }],
      })
    ).toBeNull();
    expect(
      parseAgentCommand({ ...command, subagentModels: [{ name: 'x', config: model }] })
    ).toEqual({ ...command, subagentModels: [{ name: 'x', config: model }] });
    expect(
      parseAgentCommand({
        ...command,
        subagentModels: [{ name: 'x', config: { ...model, settingsProviderId: '' } }],
      })
    ).toBeNull();
    expect(parseAgentCommand({ ...command, subagentModels: 'nope' })).toBeNull();
  });

  it('spawn-parent 的 subagentModels 接受虚拟模型配置（否则整条被拒，会话未建）', () => {
    const virtualConfig = {
      ...model,
      settingsProviderId: 'enso-virtual',
      modelId: 'auto-1',
      virtual: { name: 'Auto', primary: model, fallbacks: [] },
    };
    const command = {
      type: 'spawn-parent',
      identity: parent,
      cwd: '/repo',
      model,
      subagentModels: [{ name: 'Auto', config: virtualConfig }],
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({
        ...command,
        subagentModels: [{ name: 'Auto', config: { ...virtualConfig, virtual: { name: 'Auto' } } }],
      })
    ).toBeNull();
  });

  it('spawn model 缺 settingsProviderId 必须拒绝：worker 回报 ready 模型身份要用它', () => {
    // 生产端 spawnModelConfig() 恒发该字段，worker 的 settingsModelRef() 缺了就抛错。
    // 解析器若放行，命令会在 worker 入口被静默丢弃 → Main 只能等 ready 握手超时。
    const { settingsProviderId: _omitted, ...withoutSettingsProvider } = model;
    expect(
      parseAgentCommand({
        type: 'spawn-parent',
        identity: parent,
        cwd: '/repo',
        model: withoutSettingsProvider,
      })
    ).toBeNull();
    expect(
      parseAgentCommand({
        type: 'spawn-parent',
        identity: parent,
        cwd: '/repo',
        model: { ...model, settingsProviderId: '' },
      })
    ).toBeNull();
  });

  it('spawn model 收下合法请求头，并丢掉非法条目', () => {
    const command = {
      type: 'spawn-parent',
      identity: parent,
      cwd: '/repo',
      model: {
        ...model,
        headers: { 'X-Ok': 'one', 'bad name': 'no', 'X-Break': 'a\nb' },
      },
    };
    expect(parseAgentCommand(command)).toEqual({
      ...command,
      model: { ...model, headers: { 'X-Ok': 'one' } },
    });
    expect(
      parseAgentCommand({
        ...command,
        model: { ...model, headers: { nope: 1 } },
      })
    ).toEqual({ ...command, model });
  });

  it('set-web-search-config 链收窄：合法透传，非法/超限拒收', () => {
    const exhausted = { type: 'set-web-search-config', chain: [], configured: true };
    expect(parseAgentCommand(exhausted)).toEqual(exhausted);
    expect(parseAgentCommand({ ...exhausted, configured: 'yes' })).toBeNull();
    const chain = [{ providerId: 'ga', modelId: 'gemini-3.8-flash' }];
    const command = { type: 'set-web-search-config', chain };
    expect(parseAgentCommand(command)).toEqual(command);
    // 空链合法（= 回退现行行为）
    expect(parseAgentCommand({ type: 'set-web-search-config', chain: [] })).toEqual({
      type: 'set-web-search-config',
      chain: [],
    });
    for (const bad of [
      { type: 'set-web-search-config' },
      { type: 'set-web-search-config', chain: 'x' },
      { type: 'set-web-search-config', chain: [{ providerId: '', modelId: 'm' }] },
      { type: 'set-web-search-config', chain: [{ providerId: 'p' }] },
      {
        type: 'set-web-search-config',
        chain: Array.from({ length: 9 }, (_, i) => ({ providerId: `p${i}`, modelId: 'm' })),
      },
    ]) {
      expect(parseAgentCommand(bad)).toBeNull();
    }
  });

  it('spawn-child 不再接受历史 Enso 类型、enso-locked 工具档或 lockedProfileId', () => {
    const config = {
      typeKey: 'builtin:scout',
      spawnSpecId: SPAWN_SPEC_ID,
      displayName: 'Scout',
      description: 'Read-only scout',
      systemPrompt: 'scout role',
      model,
      tools: 'readonly',
      skillBindingIds: [],
      skillPaths: [],
      mcpBindingIds: [],
      systemPromptHash: proof.systemPromptHash,
      mcpServers: [],
    };
    const command = { type: 'spawn-child', identity: child, cwd: '/repo', config };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({
        ...command,
        identity: legacyEnsoChild,
        config: { ...config, typeKey: 'agent:enso' },
      })
    ).toBeNull();
    expect(
      parseAgentCommand({ ...command, config: { ...config, tools: 'enso-locked' } })
    ).toBeNull();
    expect(
      parseAgentCommand({ ...command, config: { ...config, lockedProfileId: 'enso-locked-v1' } })
    ).toBeNull();
  });

  it('历史 Enso child metadata 仍可解析（restoreChildren 依赖它安全跳过）', () => {
    const metadata = {
      parentId: parent.sessionId,
      childGeneration: legacyEnsoChild.generation,
      agentTypeKey: 'agent:enso',
      agentInstanceId: legacyEnsoChild.instanceId,
      agentInstanceName: legacyEnsoChild.instanceName,
      dispatchOrigin: 'typed-mention',
      lockedProfileId: 'enso-locked-v1',
    };
    expect(parseChildConversationMetadata(metadata)).toEqual(metadata);
    expect(parseChildConversationMetadata({ ...metadata, lockedProfileId: undefined })).toBeNull();
    expect(
      parseChildConversationMetadata({ ...metadata, agentTypeKey: 'builtin:scout' })
    ).toBeNull();
  });

  it('spawn-child 透传类型级 reasoning/thinkingLevel；非法值拒绝', () => {
    const baseConfig = {
      typeKey: 'builtin:scout',
      spawnSpecId: SPAWN_SPEC_ID,
      displayName: 'Scout',
      description: 'Read-only scout',
      systemPrompt: 'scout role',
      model,
      tools: 'readonly',
      skillBindingIds: [],
      skillPaths: [],
      mcpBindingIds: [],
      systemPromptHash: proof.systemPromptHash,
      mcpServers: [],
    };
    const command = {
      type: 'spawn-child',
      identity: child,
      cwd: '/repo',
      config: { ...baseConfig, reasoning: 'on', thinkingLevel: 'xhigh' },
    };
    expect(parseAgentCommand(command)).toEqual(command);
    // 缺省不带 → 合法（字段可选）
    expect(parseAgentCommand({ ...command, config: baseConfig })).toEqual({
      ...command,
      config: baseConfig,
    });
    // 白名单外的取值一律拒收（协议是 Main→worker 的信任边界）
    for (const bad of [
      { ...baseConfig, reasoning: 'auto' },
      { ...baseConfig, thinkingLevel: 'extreme' },
      { ...baseConfig, thinkingLevel: 3 },
    ]) {
      expect(parseAgentCommand({ ...command, config: bad })).toBeNull();
    }
  });

  it('prompt-child 首条 task 绑定 child generation/requestId，旧 generation 拒绝', () => {
    const command = { type: 'prompt-child', identity: child, requestId: 'dispatch-1', task };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(
      parseAgentCommand({
        ...command,
        identity: { ...child, generation: PARENT_GENERATION },
      })
    ).toBeNull();
  });

  it('prompt-child 只接受 true 的 requestBudget 标记，其他值与未知字段拒绝', () => {
    const command = { type: 'prompt-child', identity: child, requestId: 'dispatch-1', task };
    expect(parseAgentCommand({ ...command, requestBudget: true })).toEqual({
      ...command,
      requestBudget: true,
    });
    expect(parseAgentCommand({ ...command, requestBudget: false })).toBeNull();
    expect(parseAgentCommand({ ...command, requestBudget: 200 })).toBeNull();
    expect(parseAgentCommand({ ...command, extra: true })).toBeNull();
  });

  it('dismiss-coworker 绑 exact parent generation，coworkerId 必须属于该父会话', () => {
    // worker 直雇 coworker（普通身份，不在 Main sessions 索引）的遥控解雇命令；
    // 身份校验落在 parent 上，coworkerId 只做归属校验防跨会话误解雇。
    const command = {
      type: 'dismiss-coworker',
      parent,
      coworkerId: 'conversation-1::cw-bob',
      notify: true,
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, notify: undefined })).toEqual({
      ...command,
      notify: undefined,
    });
    // coworkerId 不属于 parent → 拒绝（防把别的会话的 coworker 解掉）
    expect(parseAgentCommand({ ...command, coworkerId: 'conversation-2::cw-bob' })).toBeNull();
    expect(parseAgentCommand({ ...command, coworkerId: '' })).toBeNull();
    expect(parseAgentCommand({ ...command, parent: { sessionId: 'conversation-1' } })).toBeNull();
    // 未知字段拒绝（白名单三方一致）
    expect(parseAgentCommand({ ...command, resumeFile: '/tmp/x.jsonl' })).toBeNull();
  });

  it('resume-coworker 绑 exact parent，resumeFile 必填，coworkerId 归属校验', () => {
    // 双形状过渡命令：Main 从自己读的持久化取 name/agentType/resumeFile，
    // 渲染层永远不参与——但解析器仍要把关：缺 resumeFile 的、跨会话的都拒。
    const command = {
      type: 'resume-coworker',
      parent,
      coworkerId: 'conversation-1::cw-bob',
      name: 'bob',
      agentType: 'scout',
      resumeFile: '/tmp/sessions/bob.jsonl',
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, agentType: undefined })).toEqual({
      ...command,
      agentType: undefined,
    });
    expect(parseAgentCommand({ ...command, resumeFile: '' })).toBeNull();
    expect(parseAgentCommand({ ...command, resumeFile: undefined })).toBeNull();
    expect(parseAgentCommand({ ...command, name: '' })).toBeNull();
    expect(parseAgentCommand({ ...command, coworkerId: 'conversation-2::cw-bob' })).toBeNull();
    expect(parseAgentCommand({ ...command, extra: 1 })).toBeNull();
  });

  it('已移除的 capability-result 命令拒收', () => {
    expect(
      parseAgentCommand({
        type: 'capability-result',
        child,
        turnId: 'turn-1',
        requestId: 'cap-1',
        envelope: { modelResult: { ok: true, data: { changed: true } }, receipt },
      })
    ).toBeNull();
  });
});
