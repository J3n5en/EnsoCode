import { describe, expect, it } from 'vitest';
import {
  parseAgentCommand,
  parseAgentWorkerEvent,
  parseResolvedChildProfileProof,
  parseTitleSummaryInput,
} from './agent';
import { child, model, parent, proof, RECEIPT_ID } from './agent.testUtils';

describe('removed project memory protocol', () => {
  it('拒绝旧记忆管线命令与进度事件', () => {
    expect(
      parseAgentCommand({ type: 'run-memory-pipeline', requestId: RECEIPT_ID, cwd: '/repo', model })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({ type: 'memory-pipeline-done', requestId: RECEIPT_ID, ok: true })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({
        type: 'memory-pipeline-progress',
        requestId: RECEIPT_ID,
        phase: 'stage1',
        current: 1,
        total: 1,
      })
    ).toBeNull();
  });

  it('父会话正常启动，但不再接受旧记忆配置字段', () => {
    const command = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, localMemoryEnabled: true })).toBeNull();
    expect(parseAgentCommand({ ...command, memoryPhase2Model: model })).toBeNull();
  });
});

describe('一次性文本补全命令', () => {
  it('接受正整数输出预算并拒绝脏值', () => {
    const command = {
      type: 'complete-text',
      requestId: 'completion-1',
      systemPrompt: 'system',
      userText: 'user',
      candidates: [model],
      timeoutMs: 1000,
      maxTokens: 1024,
    };
    expect(parseAgentCommand(command)).toEqual(command);
    const { maxTokens: _maxTokens, ...withoutBudget } = command;
    expect(parseAgentCommand(withoutBudget)).toEqual(withoutBudget);
    for (const maxTokens of [0, -1, 1.5, Number.NaN, '1024']) {
      expect(parseAgentCommand({ ...command, maxTokens })).toBeNull();
    }
  });

  it('接受 abort-complete-text 并拒绝脏 requestId', () => {
    const command = { type: 'abort-complete-text', requestId: 'completion-1' };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ type: 'abort-complete-text', requestId: '' })).toBeNull();
    expect(parseAgentCommand({ type: 'abort-complete-text' })).toBeNull();
  });

  it('classify-choice：校验分类器、criteria 与超时', () => {
    const command = {
      type: 'classify-choice',
      requestId: 'route-1',
      classifier: { provider: 'openrouter', modelId: 'cls', apiKey: 'k' },
      state: { message: 'hi', history: [{ speaker: 'Human', text: 'x' }] },
      instructions: 'who replies?',
      criteria: { a: 'Alice', b: 'Bob' },
      timeoutMs: 3000,
    };
    expect(parseAgentCommand(command)).toEqual(command);
    const { apiKey: _apiKey, ...noKey } = command.classifier;
    expect(parseAgentCommand({ ...command, classifier: noKey })).not.toBeNull();
    const gateway = { ...command.classifier, baseUrl: 'https://gw.example.test/v1' };
    expect(parseAgentCommand({ ...command, classifier: gateway })).toEqual({
      ...command,
      classifier: gateway,
    });
    expect(
      parseAgentCommand({ ...command, classifier: { ...command.classifier, baseUrl: '' } })
    ).toBeNull();
    for (const bad of [
      { ...command, requestId: '' },
      { ...command, classifier: { provider: '', modelId: 'cls' } },
      { ...command, classifier: { ...command.classifier, extra: 1 } },
      { ...command, criteria: {} },
      { ...command, criteria: { a: 1 } },
      { ...command, state: [] },
      { ...command, instructions: 1 },
      { ...command, timeoutMs: 0 },
      { ...command, extra: true },
    ]) {
      expect(parseAgentCommand(bad)).toBeNull();
    }
    expect(parseAgentCommand({ type: 'abort-classify-choice', requestId: 'route-1' })).toEqual({
      type: 'abort-classify-choice',
      requestId: 'route-1',
    });
    expect(parseAgentCommand({ type: 'abort-classify-choice', requestId: '' })).toBeNull();
  });

  it('choice-classified / choice-failed 事件', () => {
    const done = { type: 'choice-classified', requestId: 'r', probabilities: { a: 0.7, b: 0.3 } };
    expect(parseAgentWorkerEvent(done)).toEqual(done);
    expect(parseAgentWorkerEvent({ ...done, probabilities: { a: 'x' } })).toBeNull();
    const failed = { type: 'choice-failed', requestId: 'r', error: 'aborted' };
    expect(parseAgentWorkerEvent(failed)).toEqual(failed);
    expect(parseAgentWorkerEvent({ ...failed, error: '' })).toBeNull();
  });

  it('接受 stream 与 reasoning，拒绝脏值', () => {
    const command = {
      type: 'complete-text',
      requestId: 'completion-1',
      systemPrompt: 'system',
      userText: 'user',
      candidates: [model],
      timeoutMs: 1000,
      stream: true as const,
      reasoning: 'high' as const,
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, reasoning: 'off' })).toEqual({
      ...command,
      reasoning: 'off',
    });
    expect(parseAgentCommand({ ...command, stream: false })).toBeNull();
    expect(parseAgentCommand({ ...command, reasoning: 'nope' })).toBeNull();
  });

  it('探测调用只接受 probe: true', () => {
    const command = {
      type: 'complete-text',
      requestId: 'probe-1',
      systemPrompt: 'You are a connectivity check. Reply with OK.',
      userText: 'ping',
      candidates: [model],
      timeoutMs: 1000,
      maxTokens: 256,
      probe: true as const,
    };
    expect(parseAgentCommand(command)).toEqual(command);
    for (const probe of [false, 'true', 1, ''])
      expect(parseAgentCommand({ ...command, probe })).toBeNull();
  });
});

describe('标题总结命令与事件', () => {
  const secondModel = { ...model, modelId: 'fallback-model' };
  const summarizeInitial = {
    type: 'summarize-title',
    conversationId: 'conversation-1',
    input: { kind: 'initial', text: '帮我把登录页的 bug 修一下' },
    candidates: [model],
  };
  const summarizeRolling = {
    type: 'summarize-title',
    conversationId: 'conversation-1',
    input: {
      kind: 'rolling',
      currentTitle: '修复登录 bug',
      firstUserText: '帮我把登录页的 bug 修一下',
      userText: '这个修复有通用性吗',
      assistantText: '只影响登录路径',
    },
    candidates: [model, secondModel],
  };

  it('summarize-title 命令 initial 输入完整往返；缺字段或空值拒绝', () => {
    expect(parseAgentCommand(summarizeInitial)).toEqual(summarizeInitial);
    expect(parseAgentCommand({ ...summarizeInitial, conversationId: '' })).toBeNull();
    expect(
      parseAgentCommand({ ...summarizeInitial, input: { kind: 'initial', text: '' } })
    ).toBeNull();
    expect(parseAgentCommand({ ...summarizeInitial, candidates: undefined })).toBeNull();
    expect(parseAgentCommand({ ...summarizeInitial, extra: 1 })).toBeNull();
  });

  it('summarize-title 命令 rolling 输入完整往返（含多候选）', () => {
    expect(parseAgentCommand(summarizeRolling)).toEqual(summarizeRolling);
  });

  it('summarize-title candidates 接受 1–3 项；空数组、超过 3 项、非数组拒绝', () => {
    const third = { ...model, modelId: 'third-model' };
    expect(
      parseAgentCommand({ ...summarizeInitial, candidates: [model, secondModel, third] })
    ).not.toBeNull();
    expect(parseAgentCommand({ ...summarizeInitial, candidates: [] })).toBeNull();
    expect(
      parseAgentCommand({
        ...summarizeInitial,
        candidates: [model, secondModel, third, { ...model, modelId: 'fourth' }],
      })
    ).toBeNull();
    expect(parseAgentCommand({ ...summarizeInitial, candidates: model })).toBeNull();
  });

  it('summarize-title 旧形状（单 model 字段而无 candidates）拒绝', () => {
    const { candidates: _omitted, ...rest } = summarizeInitial;
    expect(parseAgentCommand({ ...rest, model })).toBeNull();
  });

  it('summarize-title 旧形状（顶层 text 字段而无 input）拒绝', () => {
    const legacy = {
      type: 'summarize-title',
      conversationId: 'conversation-1',
      text: '帮我把登录页的 bug 修一下',
      candidates: [model],
    };
    expect(parseAgentCommand(legacy)).toBeNull();
  });

  it('summarize-title 的候选缺 settingsProviderId 拒绝（与 spawn 同约束）', () => {
    const { settingsProviderId: _omitted, ...rest } = model;
    expect(parseAgentCommand({ ...summarizeInitial, candidates: [rest] })).toBeNull();
    expect(parseAgentCommand({ ...summarizeInitial, candidates: [model, rest] })).toBeNull();
  });

  const rolling = {
    kind: 'rolling',
    currentTitle: 't',
    firstUserText: 'f',
    userText: 'u',
    assistantText: 'a',
  };
  it.each([
    ['initial', { kind: 'initial', text: 'hi' }],
    ['rolling', rolling],
    ['rolling 的 firstUserText 允许为空串', { ...rolling, firstUserText: '' }],
  ])('parseTitleSummaryInput 合法形状原样通过：%s', (_name, input) => {
    expect(parseTitleSummaryInput(input)).toEqual(input);
  });

  it.each([
    ['null', null],
    ['空对象', {}],
    ['initial 缺 text', { kind: 'initial' }],
    ['initial 空 text', { kind: 'initial', text: '' }],
    ['initial 纯空白 text', { kind: 'initial', text: '   ' }],
    ['initial 多余字段', { kind: 'initial', text: 'x', extra: 1 }],
    ['未知 kind', { kind: 'other', text: 'x' }],
    ['rolling 空 currentTitle', { ...rolling, currentTitle: '' }],
    [
      'rolling 缺 firstUserText 键',
      { kind: 'rolling', currentTitle: 't', userText: 'u', assistantText: 'a' },
    ],
    ['rolling firstUserText 非字符串', { ...rolling, firstUserText: 1 }],
    ['rolling userText 非字符串', { ...rolling, userText: 1 }],
    ['rolling userText 与 assistantText 都为空', { ...rolling, userText: '', assistantText: '' }],
  ])('parseTitleSummaryInput 非法形状返回 null：%s', (_name, input) => {
    expect(parseTitleSummaryInput(input)).toBeNull();
  });

  it('title-generated 事件完整往返；脏输入不崩', () => {
    const event = {
      type: 'title-generated',
      conversationId: 'conversation-1',
      title: '修复登录 bug',
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, title: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, title: 42 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, conversationId: undefined })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, extra: true })).toBeNull();
  });

  it('text-delta 允许空 text，thinking 可选，拒绝脏输入', () => {
    const event = { type: 'text-delta', requestId: 'completion-1', text: 'hel' };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, text: '' })).toEqual({ ...event, text: '' });
    expect(parseAgentWorkerEvent({ ...event, thinking: 'hmm' })).toEqual({
      ...event,
      thinking: 'hmm',
    });
    expect(parseAgentWorkerEvent({ ...event, thinking: 1 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, requestId: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, extra: true })).toBeNull();
  });

  it('rewind-done 保留待回填图片并拒绝脏图片', () => {
    const event = {
      type: 'rewind-done',
      identity: parent,
      seq: 3,
      editorText: '再试一次',
      editorImages: [{ data: 'AAAA', mimeType: 'image/png' }],
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(
      parseAgentWorkerEvent({ ...event, editorImages: [{ data: 7, mimeType: 'image/png' }] })
    ).toBeNull();
  });

  it('snapshot 事件外壳保留 partial / sessionId：空 targeted 快照靠 sessionId 路由收回 started', () => {
    const empty = { type: 'snapshot', sessions: [], partial: true, sessionId: 'evicted' };
    expect(parseAgentWorkerEvent(empty)).toEqual(empty);
    const full = { type: 'snapshot', sessions: [] };
    expect(parseAgentWorkerEvent(full)).toEqual(full);
    expect(parseAgentWorkerEvent({ type: 'snapshot', sessions: [{ bogus: true }] })).toBeNull();
  });

  it('title-failed 事件完整往返；缺 error / 空串 / 多余键 → null', () => {
    const event = {
      type: 'title-failed',
      conversationId: 'conversation-1',
      error: 'cursor/composer-2.5-fast: timed out after 60s',
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, error: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, error: undefined })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, error: 7 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, conversationId: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, identity: parent })).toBeNull();
  });

  it('turn-failed 的 undelivered 只接受 true/缺省', () => {
    const event = { type: 'turn-failed', identity: parent, seq: 3, turnId: 't', error: 'stuck' };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, undelivered: true })).toEqual({
      ...event,
      undelivered: true,
    });
    expect(parseAgentWorkerEvent({ ...event, undelivered: 'yes' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, undelivered: false })).toBeNull();
  });

  it('turn-completed 带合法 digest 往返', () => {
    const event = {
      type: 'turn-completed',
      identity: parent,
      seq: 1,
      turnId: 'turn-1',
      digest: { firstUserText: '开场请求', userText: '本轮请求', assistantText: '本轮结论' },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
  });

  it('turn-completed digest 的 firstUserText 允许空串（冷会话无首条）', () => {
    const event = {
      type: 'turn-completed',
      identity: parent,
      seq: 1,
      turnId: 'turn-1',
      digest: { firstUserText: '', userText: '本轮请求', assistantText: '本轮结论' },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
  });

  it('turn-completed digest 形状非法 → 整条事件返回 null', () => {
    const base = {
      type: 'turn-completed',
      identity: parent,
      seq: 1,
      turnId: 'turn-1',
    };
    expect(
      parseAgentWorkerEvent({
        ...base,
        digest: { firstUserText: 'f', userText: 1, assistantText: 'a' },
      })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({ ...base, digest: { firstUserText: 'f', userText: 'u' } })
    ).toBeNull();
    // 旧两键形状：缺 firstUserText 即拒绝，不做兼容层
    expect(
      parseAgentWorkerEvent({ ...base, digest: { userText: 'u', assistantText: 'a' } })
    ).toBeNull();
    expect(parseAgentWorkerEvent({ ...base, digest: 'nope' })).toBeNull();
    expect(
      parseAgentWorkerEvent({
        ...base,
        digest: { firstUserText: 'f', userText: 'u', assistantText: 'a', extra: 1 },
      })
    ).toBeNull();
  });

  it('turn-completed 无 digest 仍合法', () => {
    const event = {
      type: 'turn-completed',
      identity: parent,
      seq: 1,
      turnId: 'turn-1',
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
  });

  it('turn-completed 预算停止标记只接受 true，补报告错误必须随标记出现', () => {
    const event = { type: 'turn-completed', identity: parent, seq: 1, turnId: 'turn-1' };
    const stopped = { ...event, requestBudgetStop: true, requestBudgetError: '529 overloaded' };
    expect(parseAgentWorkerEvent(stopped)).toEqual(stopped);
    expect(parseAgentWorkerEvent({ ...event, requestBudgetStop: false })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, requestBudgetError: 'oops' })).toBeNull();
    expect(
      parseAgentWorkerEvent({ ...event, requestBudgetStop: true, requestBudgetError: '' })
    ).toBeNull();
  });
});

describe('generation lifecycle/events', () => {
  it('阶段13：parent-rejected / parent-ended 可回显实例号；多字段、少字段、类型不对都拒绝', () => {
    const instanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    for (const type of ['parent-rejected', 'parent-ended']) {
      const event = { type, identity: parent, seq: 0, reason: 'gone' };
      expect(parseAgentWorkerEvent(event)).toEqual(event);
      expect(parseAgentWorkerEvent({ ...event, instanceId })).toEqual({ ...event, instanceId });
      for (const bad of ['', 'not-a-uuid', 1, null])
        expect(parseAgentWorkerEvent({ ...event, instanceId: bad })).toBeNull();
      expect(parseAgentWorkerEvent({ ...event, instanceId, command: 'prompt' })).toBeNull();
      const { reason: _reason, ...withoutReason } = event;
      expect(parseAgentWorkerEvent({ ...withoutReason, instanceId })).toBeNull();
    }
  });

  it('parent/child ready 使用 exact profile proof，缺资源或伪字段拒绝', () => {
    expect(
      parseAgentWorkerEvent({
        type: 'parent-ready',
        identity: parent,
        seq: 1,
        sessionFile: '/parent.jsonl',
        model: { providerId: 'p', modelId: 'm' },
      })
    ).not.toBeNull();
    const ready = {
      type: 'child-ready',
      identity: child,
      seq: 2,
      sessionFile: '/child.jsonl',
      proof,
    };
    expect(parseResolvedChildProfileProof(proof)).toEqual(proof);
    expect(parseAgentWorkerEvent(ready)).toEqual(ready);
    expect(
      parseAgentWorkerEvent({ ...ready, identity: { ...child, generation: 'old' } })
    ).toBeNull();
    expect(parseAgentWorkerEvent({ ...ready, rendererVerified: true })).toBeNull();
    expect(
      parseAgentWorkerEvent({ type: 'status', sessionId: child.sessionId, seq: 3, status: 'idle' })
    ).toBeNull();
  });

  it('turn-retry 事件携重试元信息，缺字段或类型不符拒绝', () => {
    const retry = {
      type: 'turn-retry',
      identity: child,
      seq: 3,
      attempt: 1,
      maxAttempts: 3,
      delayMs: 4000,
      error: '503 status code (no body)',
    };
    expect(parseAgentWorkerEvent(retry)).toEqual(retry);
    expect(parseAgentWorkerEvent({ ...retry, attempt: 0 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...retry, maxAttempts: '3' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...retry, maxAttempts: 0 })).toEqual({
      ...retry,
      maxAttempts: 0,
    });
    expect(parseAgentWorkerEvent({ ...retry, maxAttempts: -1 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...retry, delayMs: -1 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...retry, error: '' })).toBeNull();
    const { error: _dropped, ...withoutError } = retry;
    expect(parseAgentWorkerEvent(withoutError)).toBeNull();
  });

  it('retry-skipped 回执只认 busy / nothing-to-retry，缺字段、多字段或取值不符拒绝', () => {
    const skipped = { type: 'retry-skipped', identity: parent, seq: 4, reason: 'nothing-to-retry' };
    expect(parseAgentWorkerEvent(skipped)).toEqual(skipped);
    expect(parseAgentWorkerEvent({ ...skipped, reason: 'busy' })).toEqual({
      ...skipped,
      reason: 'busy',
    });
    expect(parseAgentWorkerEvent({ ...skipped, identity: child })).toEqual({
      ...skipped,
      identity: child,
    });
    expect(parseAgentWorkerEvent({ ...skipped, reason: 'other' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...skipped, reason: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...skipped, error: 'x' })).toBeNull();
    const { reason: _reason, ...withoutReason } = skipped;
    expect(parseAgentWorkerEvent(withoutReason)).toBeNull();
    expect(parseAgentWorkerEvent({ ...skipped, seq: -1 })).toBeNull();
  });

  it('session-meta 可带 usageTotals；脏统计只丢统计不丢事件', () => {
    const usageTotals = { inputTokens: 300, outputTokens: 10, cacheHitPercent: 63 };
    const withTotals = { type: 'session-meta', identity: parent, seq: 5, usageTotals };
    expect(parseAgentWorkerEvent(withTotals)).toEqual(withTotals);
    expect(
      parseAgentWorkerEvent({ ...withTotals, usageTotals: { inputTokens: -1, outputTokens: 'x' } })
    ).toEqual({ type: 'session-meta', identity: parent, seq: 5 });
  });

  it('session-meta 可带 occupancy；脏桶拒绝', () => {
    const occupancy = {
      buckets: {
        system: 1,
        instructions: 2,
        skills: 0,
        tools: 1,
        conversation: 10,
        compaction: 0,
        projectMemory: 0,
        reminders: 0,
      },
      used: 14,
      estimated: true as const,
      compactedMessageCount: 0,
      compactionModelMismatch: false,
    };
    const event = {
      type: 'session-meta',
      identity: parent,
      seq: 4,
      sessionFile: '/s.jsonl',
      occupancy,
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(
      parseAgentWorkerEvent({
        ...event,
        occupancy: { ...occupancy, estimated: false },
      })
    ).toEqual({
      ...event,
      occupancy: { ...occupancy, estimated: false },
    });
    expect(
      parseAgentWorkerEvent({
        ...event,
        occupancy: { ...occupancy, estimated: 'yes' },
      })
    ).toBeNull();
    expect(
      parseAgentWorkerEvent({
        ...event,
        occupancy: { ...occupancy, buckets: { ...occupancy.buckets, system: -1 } },
      })
    ).toBeNull();
  });

  it('abort-retry 命令只携 identity，多余字段拒绝', () => {
    const command = { type: 'abort-retry', identity: parent };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, extra: true })).toBeNull();
    expect(parseAgentCommand({ type: 'abort-retry' })).toBeNull();
  });

  it('withdraw-steer 命令携 identity 与合法 deliveryId，多余字段拒绝', () => {
    const command = { type: 'withdraw-steer', identity: parent, deliveryId: 'd-1' };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, extra: true })).toBeNull();
    expect(parseAgentCommand({ ...command, deliveryId: '' })).toBeNull();
    expect(parseAgentCommand({ ...command, deliveryId: 'x'.repeat(129) })).toBeNull();
    expect(parseAgentCommand({ type: 'withdraw-steer', identity: parent })).toBeNull();
  });

  it('retry 命令只携 identity，多余字段拒绝', () => {
    const command = { type: 'retry', identity: parent };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, extra: true })).toBeNull();
    expect(parseAgentCommand({ type: 'retry' })).toBeNull();
    expect(parseAgentCommand({ ...command, unfinishedOnly: true })).toEqual({
      ...command,
      unfinishedOnly: true,
    });
    for (const bad of [false, 1, 'true', null])
      expect(parseAgentCommand({ ...command, unfinishedOnly: bad })).toBeNull();
  });

  it('snapshot 可带可选 sessionId', () => {
    expect(parseAgentCommand({ type: 'snapshot' })).toEqual({ type: 'snapshot' });
    expect(parseAgentCommand({ type: 'snapshot', sessionId: 'c1' })).toEqual({
      type: 'snapshot',
      sessionId: 'c1',
    });
    expect(parseAgentCommand({ type: 'snapshot', sessionId: '' })).toBeNull();
    expect(parseAgentCommand({ type: 'snapshot', extra: 1 })).toBeNull();
  });

  it('set-proxy-env 只接受 string|null 值的 env 映射，多余字段拒绝', () => {
    // 代理切换后 Main 推给 worker 的 env 补丁；null 表示删除该键。
    const command = {
      type: 'set-proxy-env',
      env: { HTTP_PROXY: 'http://127.0.0.1:7890', NO_PROXY: null },
    };
    expect(parseAgentCommand(command)).toEqual(command);
    expect(parseAgentCommand({ ...command, extra: 1 })).toBeNull();
    expect(parseAgentCommand({ type: 'set-proxy-env' })).toBeNull();
    expect(parseAgentCommand({ type: 'set-proxy-env', env: 'x' })).toBeNull();
    expect(parseAgentCommand({ type: 'set-proxy-env', env: { HTTP_PROXY: 1 } })).toBeNull();
    expect(parseAgentCommand({ type: 'set-proxy-env', env: { HTTP_PROXY: undefined } })).toBeNull();
  });

  it('set-approval-mode 接受 assistant 合法字面量；未知 mode 不解析成 assistant', () => {
    const base = { type: 'set-approval-mode', identity: parent, mode: 'assistant' };
    expect(parseAgentCommand(base)).toEqual(base);
    expect(parseAgentCommand({ ...base, mode: 'bogus-mode' })).toBeNull();
    expect(parseAgentCommand({ ...base, mode: undefined })).toBeNull();
  });

  it('set-approval-mode 的无人值守开关：布尔可选，非布尔与未知键整体拒绝', () => {
    const base = { type: 'set-approval-mode', identity: parent, mode: 'supervised' };
    expect(parseAgentCommand({ ...base, autoReject: true })).toEqual({ ...base, autoReject: true });
    expect(parseAgentCommand(base)).toEqual(base);
    expect(parseAgentCommand({ ...base, autoReject: 'yes' })).toBeNull();
    expect(parseAgentCommand({ ...base, autoReject: 1 })).toBeNull();
    expect(parseAgentCommand({ ...base, bogus: true })).toBeNull();
  });

  it('pin-sessions 只接受字符串数组（脏项整体拒绝）', () => {
    expect(parseAgentCommand({ type: 'pin-sessions', sessionIds: [] })).toEqual({
      type: 'pin-sessions',
      sessionIds: [],
    });
    expect(parseAgentCommand({ type: 'pin-sessions', sessionIds: ['a', 'b'] })).toEqual({
      type: 'pin-sessions',
      sessionIds: ['a', 'b'],
    });
    expect(parseAgentCommand({ type: 'pin-sessions', sessionIds: ['a', 1] })).toBeNull();
    expect(parseAgentCommand({ type: 'pin-sessions', sessionIds: 'a' })).toBeNull();
    expect(parseAgentCommand({ type: 'pin-sessions' })).toBeNull();
  });

  it('turn 事件必须 exact identity generation + turnId；已移除的 capability-invoke 拒收', () => {
    expect(
      parseAgentWorkerEvent({
        type: 'turn-completed',
        identity: child,
        seq: 3,
        turnId: 'turn-1',
      })
    ).not.toBeNull();
    expect(
      parseAgentWorkerEvent({
        type: 'capability-invoke',
        child,
        seq: 4,
        turnId: 'turn-1',
        requestId: 'cap-1',
        capabilityId: 'appearance.theme',
        params: { value: 'dark' },
      })
    ).toBeNull();
  });
});
