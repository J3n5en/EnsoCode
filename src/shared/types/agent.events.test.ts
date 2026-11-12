import { describe, expect, it } from 'vitest';
import {
  parseAgentCommand,
  parseAgentSessionCustomEntry,
  parseAgentWorkerEvent,
  parseChildSessionIdentity,
  parseDispatchMainEvent,
  parseSafeJournalProjection,
  parseSafeJournalRecord,
  parseSessionSnapshot,
  shouldApplyDispatchMainEvent,
} from './agent';
import {
  CHILD_GENERATION,
  child,
  DISPATCH_ID,
  INSTANCE_ID,
  model,
  PARENT_GENERATION,
  parent,
  receipt,
} from './agent.testUtils';

describe('Main dispatch sequence and terminal authority', () => {
  const running = {
    dispatchId: DISPATCH_ID,
    child,
    mainSeq: 3,
    phase: 'running',
  } as const;
  const terminal = {
    dispatchId: DISPATCH_ID,
    child,
    mainSeq: 4,
    phase: 'terminal',
    terminal: 'completed',
    receiptSummary: 'Theme changed',
  } as const;

  it('只接受同 dispatch/exact child 的递增 Main seq，terminal 只能收口一次', () => {
    expect(parseDispatchMainEvent(running)).toEqual(running);
    expect(parseDispatchMainEvent(terminal)).toEqual(terminal);
    expect(shouldApplyDispatchMainEvent(null, running)).toBe(true);
    expect(shouldApplyDispatchMainEvent(running, { ...running, mainSeq: 2 })).toBe(false);
    expect(shouldApplyDispatchMainEvent(running, terminal)).toBe(true);
    expect(shouldApplyDispatchMainEvent(terminal, { ...terminal, mainSeq: 5 })).toBe(false);
    expect(
      shouldApplyDispatchMainEvent(running, {
        ...terminal,
        child: { ...child, generation: PARENT_GENERATION },
      })
    ).toBe(false);
  });

  it('worker seq/额外 terminal 字段不能伪造 Main dispatch 事件', () => {
    expect(parseDispatchMainEvent({ ...running, seq: 99 })).toBeNull();
    expect(parseDispatchMainEvent({ ...terminal, gatewayDone: true })).toBeNull();
    expect(parseDispatchMainEvent({ ...terminal, mainSeq: -1 })).toBeNull();
  });
});

describe('custom entry and snapshot projection', () => {
  const minimalSnapshot = {
    identity: parent,
    status: 'idle',
    messages: [],
    commands: [],
  } as const;

  it('SessionSnapshot 接受非负整数 baseIndex', () => {
    expect(parseSessionSnapshot({ ...minimalSnapshot, baseIndex: 12 })).toEqual({
      ...minimalSnapshot,
      baseIndex: 12,
    });
  });

  it('SessionSnapshot 拒绝负数 baseIndex', () => {
    expect(parseSessionSnapshot(minimalSnapshot)).toEqual(minimalSnapshot);
    expect(parseSessionSnapshot({ ...minimalSnapshot, baseIndex: -1 })).toBeNull();
  });

  it('SessionSnapshot 拒绝非整数 baseIndex', () => {
    expect(parseSessionSnapshot(minimalSnapshot)).toEqual(minimalSnapshot);
    expect(parseSessionSnapshot({ ...minimalSnapshot, baseIndex: 1.5 })).toBeNull();
  });

  it('dispatch/completed/failed/receipt 是 custom entry，不是 ProjectedMessage', () => {
    const entry = {
      kind: 'capability-receipt',
      receipt,
    };
    expect(parseAgentSessionCustomEntry(entry)).toEqual(entry);
    expect(parseAgentSessionCustomEntry({ role: 'assistant', content: [] })).toBeNull();
  });

  it('SessionSnapshot 只携 safe journal 白名单，并拒绝旧/raw SDK shape', () => {
    const metadata = {
      parentId: parent.sessionId,
      childGeneration: CHILD_GENERATION,
      agentTypeKey: 'builtin:scout',
      agentInstanceId: INSTANCE_ID,
      agentInstanceName: 'scout 3333',
      dispatchOrigin: 'typed-mention',
    };
    const safeJournal = {
      records: [
        { type: 'safe-user-text', text: 'Change the theme', at: 1 },
        {
          type: 'enso-operation',
          operationId: 'op-1',
          capabilityId: 'appearance.theme',
          toolCallId: 'tool-1',
          at: 2,
        },
        {
          type: 'safe-model-result',
          toolCallId: 'tool-1',
          modelResult: { ok: true, data: { changed: true } },
          at: 3,
        },
        { type: 'capability-receipt', receipt, at: 4 },
      ],
      partial: false,
    } as const;
    const snapshot = {
      identity: child,
      status: 'idle',
      messages: [],
      commands: [],
      child: metadata,
      customEntries: [{ kind: 'capability-receipt', receipt }],
      safeJournal,
    };
    expect(parseSafeJournalProjection(safeJournal)).toEqual(safeJournal);
    expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
    // 压缩状态要能过白名单：漏了整帧 snapshot 会被判 null 静默丢弃，表现是手机全白
    const compacted = { ...snapshot, compaction: 'running', compactionNoticeAt: 12 };
    expect(parseSessionSnapshot(compacted)).toEqual(compacted);
    expect(
      parseSafeJournalRecord({
        type: 'enso-operation',
        operationId: 'op-1',
        capabilityId: 'appearance.theme',
        toolCallId: 'tool-1',
        params: { apiKey: 'secret' },
        at: 2,
      })
    ).toBeNull();
    expect(
      parseSessionSnapshot({
        ...snapshot,
        safeJournal: {
          records: [{ type: 'sdk-message', raw: { params: {} }, at: 1 }],
          partial: false,
        },
      })
    ).toBeNull();
    expect(
      parseSessionSnapshot({
        sessionId: child.sessionId,
        status: 'idle',
        messages: [],
        commands: [],
      })
    ).toBeNull();
  });

  it('ChildSessionIdentity 不允许 parent/child 同 generation 串台或伪造 profile', () => {
    expect(parseChildSessionIdentity(child)).toEqual(child);
    expect(
      parseChildSessionIdentity({
        ...child,
        parent: { ...parent, generation: 'old' },
      })
    ).toBeNull();
    expect(parseChildSessionIdentity({ ...child, profileId: 'enso-locked-v1' })).toBeNull();
  });
});

describe('browser-invoke / browser-result', () => {
  const invoke = {
    type: 'browser-invoke',
    identity: parent,
    seq: 5,
    requestId: 'br-1',
    op: 'navigate',
    params: { url: 'http://127.0.0.1:3000' },
  };
  const result = {
    type: 'browser-result',
    identity: parent,
    requestId: 'br-1',
    ok: true,
    result: { url: 'x' },
  };

  it('browser-invoke 只接受闭集 op，identity 可为 parent 或 child', () => {
    expect(parseAgentWorkerEvent(invoke)).toEqual(invoke);
    expect(parseAgentWorkerEvent({ ...invoke, identity: child })).not.toBeNull();
    for (const op of [
      'snapshot',
      'click',
      'type',
      'fill',
      'press_key',
      'scroll',
      'cdp',
      'screenshot',
      'tabs',
      'lock',
      'close',
    ]) {
      expect(parseAgentWorkerEvent({ ...invoke, op })).not.toBeNull();
    }
    expect(parseAgentWorkerEvent({ ...invoke, op: 'hover' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, requestId: '' })).toBeNull();
    expect(
      parseAgentWorkerEvent({ ...invoke, identity: { ...parent, generation: 'old' } })
    ).toBeNull();
    const { params: _p, ...noParams } = invoke;
    expect(parseAgentWorkerEvent(noParams)).toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, extra: 1 })).toBeNull();
  });

  it('browser-result 成功带 result，失败带 error，字段互斥', () => {
    expect(parseAgentCommand(result)).toEqual(result);
    const failed = {
      type: 'browser-result',
      identity: parent,
      requestId: 'br-1',
      ok: false,
      error: 'boom',
    };
    expect(parseAgentCommand(failed)).toEqual(failed);
    expect(parseAgentCommand({ ...failed, error: '' })).toBeNull();
    expect(parseAgentCommand({ ...result, ok: false })).toBeNull();
    expect(parseAgentCommand({ ...failed, ok: true })).toBeNull();
    expect(parseAgentCommand({ ...result, requestId: '' })).toBeNull();
    expect(parseAgentCommand({ ...result, extra: 1 })).toBeNull();
  });
});

describe('memory-invoke / memory-result', () => {
  it('delegation-invoke 接受 group_history，拒绝未知 op', () => {
    const event = {
      type: 'delegation-invoke',
      identity: parent,
      seq: 1,
      requestId: 'd-1',
      op: 'group_history',
      params: { limit: 5 },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, op: 'group_secrets' })).toBeNull();
  });

  it('delegation-invoke 接受 retry_delegation；turn-failed 只接受字面 true 的 retryExhausted', () => {
    const event = {
      type: 'delegation-invoke',
      identity: parent,
      seq: 1,
      requestId: 'd-2',
      op: 'retry_delegation',
      params: { id: 'd1', note: 'again' },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    const failed = {
      type: 'turn-failed',
      identity: parent,
      seq: 2,
      turnId: 't',
      error: 'socket hang up',
      retryExhausted: true,
    };
    expect(parseAgentWorkerEvent(failed)).toEqual(failed);
    expect(parseAgentWorkerEvent({ ...failed, retryExhausted: 'yes' })).toBeNull();
  });

  const invoke = {
    type: 'memory-invoke',
    identity: parent,
    seq: 5,
    requestId: 'mem-1',
    op: 'search',
    params: { query: 'pg', limit: 10, spaceId: 'all' },
  };
  const result = {
    type: 'memory-result',
    identity: parent,
    requestId: 'mem-1',
    ok: true,
    result: { results: [] },
  };

  it('memory-invoke 只接受闭集 op，identity 可为 parent 或 child', () => {
    expect(parseAgentWorkerEvent(invoke)).toEqual(invoke);
    expect(parseAgentWorkerEvent({ ...invoke, identity: child })).not.toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, op: 'capture' })).not.toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, op: 'delete' })).not.toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, op: 'purge' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, requestId: '' })).toBeNull();
    const { params: _p, ...noParams } = invoke;
    expect(parseAgentWorkerEvent(noParams)).toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, extra: 1 })).toBeNull();
  });

  it('memory-result 成功带 result，失败带 error，字段互斥', () => {
    expect(parseAgentCommand(result)).toEqual(result);
    const failed = { ...result, ok: false, error: 'boom', result: undefined };
    delete (failed as { result?: unknown }).result;
    expect(parseAgentCommand(failed)).toEqual(failed);
    expect(parseAgentCommand({ ...failed, error: '' })).toBeNull();
    expect(parseAgentCommand({ ...result, ok: false })).toBeNull();
    expect(parseAgentCommand({ ...result, extra: 1 })).toBeNull();
  });
});

describe('computer-invoke / computer-result', () => {
  const invoke = {
    type: 'computer-invoke',
    identity: parent,
    seq: 5,
    requestId: 'cu-1',
    op: 'run',
    params: { code: 'return 1', readOnly: true, timeoutSec: 12 },
  };
  const result = {
    type: 'computer-result',
    identity: parent,
    requestId: 'cu-1',
    ok: true,
    result: { text: '1', screenshots: [] },
  };

  it('computer-invoke 只接受 run', () => {
    expect(parseAgentWorkerEvent(invoke)).toEqual(invoke);
    expect(parseAgentWorkerEvent({ ...invoke, identity: child })).not.toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, op: 'click' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...invoke, extra: 1 })).toBeNull();
  });

  it('computer-cancel 只带 requestId', () => {
    const cancel = { type: 'computer-cancel', identity: parent, seq: 6, requestId: 'cu-1' };
    expect(parseAgentWorkerEvent(cancel)).toEqual(cancel);
    expect(parseAgentWorkerEvent({ ...cancel, requestId: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...cancel, extra: 1 })).toBeNull();
  });

  it('computer-result 成功带 result，失败带 error，字段互斥', () => {
    expect(parseAgentCommand(result)).toEqual(result);
    const failed = {
      type: 'computer-result',
      identity: parent,
      requestId: 'cu-1',
      ok: false,
      error: 'boom',
    };
    expect(parseAgentCommand(failed)).toEqual(failed);
    expect(parseAgentCommand({ ...result, ok: false })).toBeNull();
    expect(parseAgentCommand({ ...failed, ok: true })).toBeNull();
  });
});

describe('tool-output 事件跨进程边界', () => {
  const event = {
    type: 'tool-output',
    identity: { sessionId: 's1', generation: '11111111-1111-4111-8111-111111111111' },
    seq: 3,
    toolCallId: 'call-1',
    output: 'step 1\nstep 2',
  };

  it('合法事件原样通过（否则 worker→main 边界会静默丢弃）', () => {
    expect(parseAgentWorkerEvent(event)).toEqual(event);
  });

  it('可选 startedAt 随事件通过，脏数字拒绝', () => {
    expect(parseAgentWorkerEvent({ ...event, startedAt: 1_000 })).toEqual({
      ...event,
      startedAt: 1_000,
    });
    expect(parseAgentWorkerEvent({ ...event, startedAt: 'now' })).toBeNull();
  });

  it('可选 deadlineAt 随事件通过，脏数字拒绝', () => {
    expect(parseAgentWorkerEvent({ ...event, deadlineAt: 2_000 })).toEqual({
      ...event,
      deadlineAt: 2_000,
    });
    expect(parseAgentWorkerEvent({ ...event, deadlineAt: 'later' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, deadlineAt: Number.NaN })).toBeNull();
  });

  it('脏输入拒绝', () => {
    expect(parseAgentWorkerEvent({ ...event, toolCallId: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, output: 42 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, identity: undefined })).toBeNull();
  });
});

describe('MCP 旁路事件收窄', () => {
  const status = {
    type: 'mcp-status',
    serverId: 'srv-1',
    serverName: 'notion',
    state: 'ready',
    toolCount: 3,
  };

  it('合法 mcp-status 通过，脏字段拒绝', () => {
    expect(parseAgentWorkerEvent(status)).toEqual(status);
    expect(parseAgentWorkerEvent({ type: 'mcp-status', serverName: 'n', state: 'error' })).toEqual({
      type: 'mcp-status',
      serverName: 'n',
      state: 'error',
    });
    expect(parseAgentWorkerEvent({ ...status, serverId: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...status, serverId: 42 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...status, toolCount: 'many' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...status, toolCount: -1 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...status, error: 42 })).toBeNull();
    // 该事件广播到所有窗口：多余字段一律拒绝
    expect(parseAgentWorkerEvent({ ...status, html: '<script>' })).toBeNull();
  });

  it('mcp-status 的 scopeChallenge 只收字符串 scope 与合法 URL', () => {
    const challenged = {
      ...status,
      state: 'unauthorized',
      scopeChallenge: {
        scope: 'files:write',
        resourceMetadataUrl: 'https://mcp.test/.well-known/x',
      },
    };
    expect(parseAgentWorkerEvent(challenged)).toEqual(challenged);
    expect(parseAgentWorkerEvent({ ...status, scopeChallenge: { scope: 1 } })).toBeNull();
    expect(
      parseAgentWorkerEvent({ ...status, scopeChallenge: { resourceMetadataUrl: 'not a url' } })
    ).toBeNull();
    expect(parseAgentWorkerEvent({ ...status, scopeChallenge: { scope: 'a', x: 1 } })).toBeNull();
  });

  it('mcp-oauth-refresh 只带 server 与被拒 token 指纹，不带凭据', () => {
    const event = { type: 'mcp-oauth-refresh', requestId: 'r1', serverId: 'srv-1' };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(parseAgentWorkerEvent({ ...event, rejected: 'abcd' })).toEqual({
      ...event,
      rejected: 'abcd',
    });
    expect(parseAgentWorkerEvent({ ...event, serverId: '' })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, requestId: 1 })).toBeNull();
    expect(parseAgentWorkerEvent({ ...event, refresh_token: 'r' })).toBeNull();
    // worker 不再自行 refresh：旧的回传事件一律拒收
    expect(
      parseAgentWorkerEvent({
        type: 'mcp-tokens-refreshed',
        serverId: 'srv-1',
        tokens: { access_token: 'a' },
      })
    ).toBeNull();
  });

  it('mcp-oauth-refresh-result 只放行 access token，refresh_token 不进 worker', () => {
    const ok = {
      type: 'mcp-oauth-refresh-result',
      requestId: 'r1',
      result: { ok: true, access: { access_token: 'a', expires_at: 1 } },
    };
    expect(parseAgentCommand(ok)).toEqual(ok);
    const failed = {
      type: 'mcp-oauth-refresh-result',
      requestId: 'r1',
      result: { ok: false, unauthorized: true, error: 'invalid_grant' },
    };
    expect(parseAgentCommand(failed)).toEqual(failed);
    expect(
      parseAgentCommand({
        ...ok,
        result: { ok: true, access: { access_token: 'a', refresh_token: 'r' } },
      })
    ).toBeNull();
    expect(parseAgentCommand({ ...ok, result: { ok: true, access: {} } })).toBeNull();
    expect(
      parseAgentCommand({
        ...ok,
        result: { ok: true, access: { access_token: 'a', expires_at: 'x' } },
      })
    ).toBeNull();
    expect(parseAgentCommand({ ...failed, result: { ok: false, error: 'x' } })).toBeNull();
    expect(parseAgentCommand({ ...ok, requestId: '' })).toBeNull();
  });
});

describe('apply_patch fileChanges 事件收窄', () => {
  it('生成图片路径在增量消息和历史快照中收窄，拒绝 URL、共享路径和脏输入', () => {
    const message = {
      role: 'toolResult',
      toolName: 'ImageGen',
      content: [],
      generatedImages: ['/tmp/a.png', 'C:\\scratch\\a.webp'],
    };
    const event = { type: 'message-upsert', identity: parent, seq: 1, index: 0, message };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(
      parseSessionSnapshot({ identity: parent, status: 'idle', messages: [message], commands: [] })
    ).not.toBeNull();
    for (const generatedImages of [null, 'bad', [null], ['https://a/a.png'], ['//server/a.png']]) {
      expect(
        parseAgentWorkerEvent({ ...event, message: { ...message, generatedImages } })
      ).toBeNull();
      expect(
        parseSessionSnapshot({
          identity: parent,
          status: 'idle',
          messages: [{ ...message, generatedImages }],
          commands: [],
        })
      ).toBeNull();
    }
  });

  const event = {
    type: 'message-upsert',
    identity: parent,
    seq: 1,
    index: 0,
    message: {
      role: 'toolResult',
      content: [],
      toolName: 'apply_patch',
      fileChanges: [{ path: 'a.ts', oldText: 'a', newText: 'b', type: 'update' }],
      applyPatchOutcome: {
        status: 'partial',
        applied: ['a.ts'],
        failed: ['b.ts'],
        error: 'write failed',
        unattempted: ['c.ts'],
        uncertain: [],
      },
    },
  } as const;

  it('接受完整白名单形状与显式 truncated', () => {
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    expect(
      parseAgentWorkerEvent({
        ...event,
        message: {
          ...event.message,
          applyPatchOutcome: {
            ...event.message.applyPatchOutcome,
            input: '*** Begin Patch\n*** End Patch',
          },
        },
      })
    ).not.toBeNull();
    expect(
      parseAgentWorkerEvent({
        ...event,
        message: {
          ...event.message,
          fileChanges: [{ ...event.message.fileChanges[0], oldText: 'a\n…', truncated: true }],
        },
      })
    ).not.toBeNull();
  });

  it('snapshot 同样收窄嵌套消息的 fileChanges', () => {
    expect(
      parseSessionSnapshot({
        identity: parent,
        status: 'idle',
        messages: [event.message],
        commands: [],
      })
    ).not.toBeNull();
    expect(
      parseSessionSnapshot({
        identity: parent,
        status: 'idle',
        messages: [
          { ...event.message, fileChanges: [{ ...event.message.fileChanges[0], extra: 1 }] },
        ],
        commands: [],
      })
    ).toBeNull();
  });

  it('拒绝 applyPatchOutcome 脏字段、超预算路径与不一致 applied', () => {
    for (const applyPatchOutcome of [
      { ...event.message.applyPatchOutcome, status: 'unknown' },
      { ...event.message.applyPatchOutcome, failed: 'b.ts' },
      { ...event.message.applyPatchOutcome, applied: ['other.ts'] },
      { ...event.message.applyPatchOutcome, failed: ['x'.repeat(4_097)] },
      { ...event.message.applyPatchOutcome, extra: true },
      { ...event.message.applyPatchOutcome, errorTruncated: false },
      { ...event.message.applyPatchOutcome, inputTruncated: false },
      { ...event.message.applyPatchOutcome, input: '' },
    ]) {
      expect(
        parseAgentWorkerEvent({ ...event, message: { ...event.message, applyPatchOutcome } })
      ).toBeNull();
    }
  });

  it('拒绝 fileChanges 脏字段、错误类型与不显式的 truncated=false', () => {
    for (const fileChanges of [
      [{ ...event.message.fileChanges[0], secret: 'x' }],
      [{ ...event.message.fileChanges[0], oldText: 1 }],
      [{ ...event.message.fileChanges[0], type: 'move' }],
      [{ ...event.message.fileChanges[0], truncated: false }],
      null,
    ]) {
      expect(
        parseAgentWorkerEvent({ ...event, message: { ...event.message, fileChanges } })
      ).toBeNull();
    }
  });
});

describe('spawn-parent system prompt 协议', () => {
  it('spawn-parent 携 systemPrompt:非空字符串通过,脏值拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand({ ...base, systemPrompt: 'custom base prompt' })).not.toBeNull();
    expect(parseAgentCommand({ ...base, systemPrompt: '' })).toBeNull();
    expect(parseAgentCommand({ ...base, systemPrompt: 1 })).toBeNull();
  });
});

describe('受保护动作底线协议', () => {
  it('spawn-parent 携 botWriteLock：名字与祖先会话列表齐全才通过', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(
      parseAgentCommand({ ...base, botWriteLock: { label: 'alice', ancestors: ['p'] } })
    ).toMatchObject({ botWriteLock: { label: 'alice', ancestors: ['p'] } });
    expect(parseAgentCommand({ ...base, botWriteLock: { label: 'alice' } })).toBeNull();
    expect(parseAgentCommand({ ...base, botWriteLock: { label: '', ancestors: [] } })).toBeNull();
    expect(parseAgentCommand({ ...base, botWriteLock: { label: 'a', ancestors: [1] } })).toBeNull();
  });

  it('spawn-parent 携 protectedActions：布尔通过，脏值拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand({ ...base, protectedActions: true })).not.toBeNull();
    expect(parseAgentCommand({ ...base, protectedActions: 'yes' })).toBeNull();
  });

  it('approval-request 的 protected 只接受已知类别', () => {
    const event = {
      type: 'approval-request',
      identity: parent,
      seq: 1,
      request: { requestId: 'r1', tool: 'bash', kind: 'command', summary: 'rm -rf x' },
    };
    const withProtected = { ...event, request: { ...event.request, protected: 'delete' } };
    expect(parseAgentWorkerEvent(withProtected)).toEqual(withProtected);
    expect(
      parseAgentWorkerEvent({ ...event, request: { ...event.request, protected: 'nuke' } })
    ).toBeNull();
  });

  it('approval-request 的 guard 只接受非空 ruleId / reason；spawn-parent 的 dcgPath 须为非空字符串', () => {
    const event = {
      type: 'approval-request',
      identity: parent,
      seq: 1,
      request: {
        requestId: 'r1',
        tool: 'bash',
        kind: 'command',
        summary: 'git reset --hard',
        protected: 'destructive',
        guard: { ruleId: 'core.git:reset-hard', reason: 'destroys changes' },
      },
    };
    expect(parseAgentWorkerEvent(event)).toEqual(event);
    for (const guard of [{ ruleId: '', reason: 'x' }, { ruleId: 'r' }, 'x']) {
      expect(parseAgentWorkerEvent({ ...event, request: { ...event.request, guard } })).toBeNull();
    }
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand({ ...base, dcgPath: '/data/dcg/dcg' })).not.toBeNull();
    expect(parseAgentCommand({ ...base, dcgPath: '' })).toBeNull();
    expect(parseAgentCommand({ ...base, dcgPath: 1 })).toBeNull();
  });

  it('spawn-parent 携真尾 / boost / 拒答正文：非空字符串通过,脏值拒绝', () => {
    const base = { type: 'spawn-parent', identity: parent, cwd: '/repo', model };
    expect(parseAgentCommand({ ...base, systemPromptAppend: 'tail' })).not.toBeNull();
    expect(parseAgentCommand({ ...base, systemPromptBoost: 'boost' })).not.toBeNull();
    expect(parseAgentCommand({ ...base, refusalRetryPrompt: 'continue' })).not.toBeNull();
    expect(parseAgentCommand({ ...base, systemPromptAppend: '' })).toBeNull();
    expect(parseAgentCommand({ ...base, systemPromptBoost: 1 })).toBeNull();
    expect(parseAgentCommand({ ...base, refusalRetryPrompt: '' })).toBeNull();
  });
});

describe('等人超时协议', () => {
  it('agent-notify 命令只接受根会话、非空正文与布尔 urgent', () => {
    const base = {
      type: 'agent-notify',
      identity: parent,
      text: 'Subagent finished',
      urgent: false,
    };
    expect(parseAgentCommand(base)).toEqual(base);
    expect(parseAgentCommand({ ...base, text: '' })).toBeNull();
    expect(parseAgentCommand({ ...base, urgent: 'yes' })).toBeNull();
    expect(parseAgentCommand({ ...base, extra: 1 })).toBeNull();
  });

  it('request-timeout 命令只接受 approval / ask 与非空 requestId', () => {
    const base = { type: 'request-timeout', identity: parent, requestId: 'r1' };
    expect(parseAgentCommand({ ...base, kind: 'approval' })).toEqual({ ...base, kind: 'approval' });
    expect(parseAgentCommand({ ...base, kind: 'ask' })).not.toBeNull();
    expect(parseAgentCommand({ ...base, kind: 'plan' })).toBeNull();
    expect(parseAgentCommand({ ...base, kind: 'ask', requestId: '' })).toBeNull();
    expect(parseAgentCommand({ ...base, kind: 'ask', extra: 1 })).toBeNull();
  });

  it('approval-respond 接受调整与代审，拒绝未知决定', () => {
    const base = { type: 'approval-respond', identity: parent, requestId: 'r1' };
    expect(parseAgentCommand({ ...base, decision: 'revise' })).toEqual({
      ...base,
      decision: 'revise',
    });
    expect(parseAgentCommand({ ...base, decision: 'review' })).toEqual({
      ...base,
      decision: 'review',
    });
    expect(parseAgentCommand({ ...base, decision: 'allow' })).not.toBeNull();
    expect(parseAgentCommand({ ...base, decision: 'yolo' })).toBeNull();
  });

  it('approval-request / ask-request 的 expiresAt 必须是有限数字', () => {
    const approval = {
      type: 'approval-request',
      identity: parent,
      seq: 1,
      request: { requestId: 'r1', tool: 'bash', kind: 'command', summary: 'ls', expiresAt: 5 },
    };
    expect(parseAgentWorkerEvent(approval)).toEqual(approval);
    expect(
      parseAgentWorkerEvent({ ...approval, request: { ...approval.request, expiresAt: 'x' } })
    ).toBeNull();
    const ask = {
      type: 'ask-request',
      identity: parent,
      seq: 2,
      ask: { requestId: 'q', question: 'q', expiresAt: 5 },
    };
    expect(parseAgentWorkerEvent(ask)).toEqual(ask);
    expect(
      parseAgentWorkerEvent({ ...ask, ask: { ...ask.ask, expiresAt: Number.NaN } })
    ).toBeNull();
  });

  it('ask-request 的推荐项必须是选项之一', () => {
    const ask = {
      type: 'ask-request',
      identity: parent,
      seq: 3,
      ask: { requestId: 'q', question: 'q', options: ['a', 'b'], recommended: 'b' },
    };
    expect(parseAgentWorkerEvent(ask)).toEqual(ask);
    expect(parseAgentWorkerEvent({ ...ask, ask: { ...ask.ask, recommended: 'c' } })).toBeNull();
    expect(
      parseAgentWorkerEvent({ ...ask, ask: { requestId: 'q', question: 'q', recommended: 'a' } })
    ).toBeNull();
  });
});
