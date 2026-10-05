import type { ApprovalRequestInfo } from '@shared/types/agent';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalGate, summarizeApproval, withApproval, withProtectedFloor } from './approval';

// 契约（design.md 运行时数据流）：ApprovalGate 构造函数新增可选第 4 参 options，
// options.review?: (info: ApprovalRequestInfo, signal: AbortSignal | undefined) =>
//   Promise<{ decision: 'auto_allow' | 'ask_user' | 'block'; rationale?: string }>
// mode==='assistant' 且提供 review 时：ask() 先调 review()，auto_allow → 直接 resolve('allow')
// 不调 onRequest；block → resolve('deny') 不调 onRequest；ask_user 或 review 失败/throw →
// 降级走原 onRequest 流程；review 进行中 abort 仍要 fail-closed cancel。
type GateMode = 'supervised' | 'auto-edits' | 'full' | 'assistant';
type ReviewFn = (
  info: ApprovalRequestInfo,
  signal: AbortSignal | undefined
) => Promise<{ decision: 'auto_allow' | 'ask_user' | 'block'; rationale?: string }>;

const makeGate = (mode: GateMode = 'supervised', options?: { review?: ReviewFn }) => {
  const requests: string[] = [];
  const resolved: string[] = [];
  const gate = new ApprovalGate(
    mode,
    (info) => requests.push(info.requestId),
    (id) => resolved.push(id),
    options
  );
  return { gate, requests, resolved };
};

describe('summarizeApproval', () => {
  it('file-edit 显示 path', () => {
    expect(summarizeApproval('file-edit', { path: '/repo/a.ts' })).toBe('/repo/a.ts');
  });
});

describe('ApprovalGate', () => {
  it('file approval carries every parser-derived target path, not only display summary', async () => {
    const infos: ApprovalRequestInfo[] = [];
    const gate = new ApprovalGate(
      'supervised',
      (info) => {
        infos.push(info);
        gate.respond(info.requestId, 'deny');
      },
      () => undefined
    );
    const tool = withApproval(gate, 'file-edit', {
      name: 'apply_patch',
      label: 'Apply patch',
      description: '',
      parameters: {} as never,
      execute: vi.fn(),
    });
    await expect(
      tool.execute(
        'call-1',
        {
          input: [
            '*** Begin Patch',
            '*** Update File: src/a.ts',
            '-a',
            '+b',
            '*** Add File: src/b.ts',
            '+b',
            '*** End Patch',
          ].join('\n'),
        },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/denied/i);
    expect(infos[0]?.filePaths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('三档 needsApproval:full 全免,auto-edits 免 file-*,supervised 全审', () => {
    expect(makeGate('full').gate.needsApproval('command', 'bash')).toBe(false);
    const auto = makeGate('auto-edits').gate;
    expect(auto.needsApproval('file-edit', 'edit')).toBe(false);
    expect(auto.needsApproval('file-write', 'write')).toBe(false);
    expect(auto.needsApproval('command', 'bash')).toBe(true);
    expect(auto.needsApproval('mcp', 'mcp__x__y')).toBe(true);
    const sup = makeGate('supervised').gate;
    expect(sup.needsApproval('file-edit', 'edit')).toBe(true);
    expect(sup.needsApproval('command', 'bash')).toBe(true);
  });

  it('assistant 档 needsApproval 与 supervised 同集合：command/file-edit/file-write/mcp 都要审', () => {
    const assistant = makeGate('assistant').gate;
    expect(assistant.needsApproval('command', 'bash')).toBe(true);
    expect(assistant.needsApproval('file-edit', 'edit')).toBe(true);
    expect(assistant.needsApproval('file-write', 'write')).toBe(true);
    expect(assistant.needsApproval('mcp', 'mcp__x__y')).toBe(true);
  });

  it('allow / deny 决策解除挂起并回调 resolve', async () => {
    const { gate, requests, resolved } = makeGate();
    const p1 = gate.ask('bash', 'command', 'ls', undefined);
    gate.respond(requests[0], 'allow');
    await expect(p1).resolves.toBe('allow');
    const p2 = gate.ask('bash', 'command', 'rm x', undefined);
    gate.respond(requests[1], 'deny');
    await expect(p2).resolves.toBe('deny');
    expect(resolved).toEqual(requests);
  });

  it('allowSession 后同工具不再需要审批', async () => {
    const { gate, requests } = makeGate();
    const p = gate.ask('bash', 'command', 'ls', undefined);
    gate.respond(requests[0], 'allowSession');
    await expect(p).resolves.toBe('allow');
    expect(gate.needsApproval('command', 'bash')).toBe(false);
    expect(gate.needsApproval('file-edit', 'edit')).toBe(true);
  });

  it('abort signal 与 cancelAll 都按 cancel 收尾(fail-closed)', async () => {
    const { gate } = makeGate();
    const controller = new AbortController();
    const p1 = gate.ask('bash', 'command', 'ls', controller.signal);
    controller.abort();
    await expect(p1).resolves.toBe('cancel');

    const p2 = gate.ask('write', 'file-write', '/tmp/x', undefined);
    gate.cancelAll();
    await expect(p2).resolves.toBe('cancel');
    expect(gate.snapshot()).toHaveLength(0);
  });

  it('重复 respond 幂等,未知 requestId 忽略', async () => {
    const { gate, requests, resolved } = makeGate();
    const p = gate.ask('bash', 'command', 'ls', undefined);
    gate.respond('nonexistent', 'allow');
    gate.respond(requests[0], 'allow');
    gate.respond(requests[0], 'deny');
    await expect(p).resolves.toBe('allow');
    expect(resolved).toHaveLength(1);
  });

  it('snapshot 返回全部挂起请求', () => {
    const { gate } = makeGate();
    void gate.ask('bash', 'command', 'ls', undefined);
    void gate.ask('edit', 'file-edit', '/a.ts', undefined);
    const snapshot = gate.snapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((s) => s.kind)).toEqual(['command', 'file-edit']);
    gate.cancelAll();
  });
});

describe('ApprovalGate assistant 档代审 (options.review)', () => {
  it('代审开始立刻 onRequest(phase=reviewing + toolCallId)，结束 resolved 且不弹真人卡', async () => {
    const review = vi.fn().mockResolvedValue({ decision: 'auto_allow' });
    const infos: ApprovalRequestInfo[] = [];
    const resolved: string[] = [];
    const gate = new ApprovalGate(
      'assistant',
      (info) => infos.push(info),
      (id) => resolved.push(id),
      { review }
    );
    const result = await gate.ask('bash', 'command', 'ls', undefined, 'call-1');
    expect(result).toBe('allow');
    expect(infos).toEqual([
      {
        requestId: expect.stringMatching(/^apr-/),
        tool: 'bash',
        kind: 'command',
        summary: 'ls',
        toolCallId: 'call-1',
        phase: 'reviewing',
      },
    ]);
    expect(resolved).toEqual([infos[0].requestId]);
  }, 1500);

  it('reviewer 返回 auto_allow：ask() resolve allow，onRequest 只有 reviewing 不升格 ask_user', async () => {
    const review = vi.fn().mockResolvedValue({ decision: 'auto_allow' });
    const infos: ApprovalRequestInfo[] = [];
    const gate = new ApprovalGate(
      'assistant',
      (info) => infos.push(info),
      () => {},
      { review }
    );
    const result = await gate.ask('bash', 'command', 'ls', undefined, 'call-1');
    expect(result).toBe('allow');
    expect(infos).toHaveLength(1);
    expect(infos[0].phase).toBe('reviewing');
    expect(review).toHaveBeenCalledTimes(1);
  }, 1500);

  it('reviewer 返回 block：resolve block，onRequest 只有 reviewing 不升格 ask_user', async () => {
    const review = vi.fn().mockResolvedValue({ decision: 'block' });
    const infos: ApprovalRequestInfo[] = [];
    const gate = new ApprovalGate(
      'assistant',
      (info) => infos.push(info),
      () => {},
      { review }
    );
    const result = await gate.ask('bash', 'command', 'rm -rf /', undefined, 'call-2');
    expect(result).toBe('block');
    expect(infos).toHaveLength(1);
    expect(infos[0].phase).toBe('reviewing');
  }, 1500);

  it('reviewer 返回 ask_user：走 onRequest，respond allow 后 resolve allow', async () => {
    const review = vi.fn().mockResolvedValue({ decision: 'ask_user' });
    const { gate, requests } = makeGate('assistant', { review });
    const p = gate.ask('bash', 'command', 'ls', undefined);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    gate.respond(requests[0], 'allow');
    await expect(p).resolves.toBe('allow');
  });

  it('reviewer throw 时降级走 onRequest', async () => {
    const review = vi.fn().mockRejectedValue(new Error('reviewer down'));
    const { gate, requests } = makeGate('assistant', { review });
    const p = gate.ask('bash', 'command', 'ls', undefined);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    gate.respond(requests[0], 'allow');
    await expect(p).resolves.toBe('allow');
  });

  it('reviewer 返回失败映射（非法 decision）时降级走 onRequest', async () => {
    const review = vi.fn().mockResolvedValue({ decision: 'not-a-real-decision' } as never);
    const { gate, requests } = makeGate('assistant', { review });
    const p = gate.ask('bash', 'command', 'ls', undefined);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    gate.respond(requests[0], 'deny');
    await expect(p).resolves.toBe('deny');
  });

  it('abort 在评审进行中仍 cancel（fail-closed）', async () => {
    let rejectReview: (err: unknown) => void = () => {};
    const review = vi.fn(
      () =>
        new Promise<{ decision: 'auto_allow' | 'ask_user' | 'block' }>((_resolve, reject) => {
          rejectReview = reject;
        })
    );
    const { gate } = makeGate('assistant', { review });
    const controller = new AbortController();
    const p = gate.ask('bash', 'command', 'ls', controller.signal);
    controller.abort();
    await expect(p).resolves.toBe('cancel');
    rejectReview(new Error('late'));
  });
});

describe('受保护动作底线', () => {
  const tool = (name = 'bash') => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: {} });
    return {
      execute,
      def: { name, label: name, description: '', parameters: {} as never, execute },
    };
  };
  const collect = (mode: GateMode, protectedFloor: boolean, review?: ReviewFn) => {
    const infos: ApprovalRequestInfo[] = [];
    const gate = new ApprovalGate(
      mode,
      (info) => infos.push(info),
      () => undefined,
      {
        ...(review ? { review } : {}),
        protectedFloor,
      }
    );
    return { gate, infos };
  };

  it('Code 默认（未开底线）full 模式下 rm -rf 直接执行，不弹审批', async () => {
    const { gate, infos } = collect('full', false);
    const { def, execute } = tool();
    await withApproval(gate, 'command', def).execute(
      'c1',
      { command: 'rm -rf /tmp/x' },
      undefined,
      undefined,
      undefined as never
    );
    expect(infos).toHaveLength(0);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('底线开启时 full 模式仍对受保护命令要求确认，并标注类别', async () => {
    const { gate, infos } = collect('full', true);
    const { def, execute } = tool();
    const run = withApproval(gate, 'command', def).execute(
      'c1',
      { command: 'git push --force' },
      undefined,
      undefined,
      undefined as never
    );
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(infos[0].protected).toBe('delete');
    expect(execute).not.toHaveBeenCalled();
    gate.respond(infos[0].requestId, 'deny');
    await expect(run).rejects.toThrow(/denied/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('底线开启时普通命令在 full 模式照常免审', async () => {
    const { gate, infos } = collect('full', true);
    const { def, execute } = tool();
    await withApproval(gate, 'command', def).execute(
      'c1',
      { command: 'ls -la' },
      undefined,
      undefined,
      undefined as never
    );
    expect(infos).toHaveLength(0);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('「本会话总是允许」不覆盖受保护动作，且受保护审批的 allowSession 只放行一次', async () => {
    const { gate, infos } = collect('supervised', true);
    const { def, execute } = tool();
    const wrapped = withApproval(gate, 'command', def);
    const first = wrapped.execute(
      'c1',
      { command: 'ls' },
      undefined,
      undefined,
      undefined as never
    );
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    gate.respond(infos[0].requestId, 'allowSession');
    await first;
    const second = wrapped.execute(
      'c2',
      { command: 'rm -rf build' },
      undefined,
      undefined,
      undefined as never
    );
    await vi.waitFor(() => expect(infos).toHaveLength(2));
    gate.respond(infos[1].requestId, 'allowSession');
    await second;
    const third = wrapped.execute(
      'c3',
      { command: 'rm -rf dist' },
      undefined,
      undefined,
      undefined as never
    );
    await vi.waitFor(() => expect(infos).toHaveLength(3));
    gate.respond(infos[2].requestId, 'allow');
    await third;
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('assistant 模式下受保护动作跳过代审，直接等真人', async () => {
    const review = vi.fn().mockResolvedValue({ decision: 'auto_allow' });
    const { gate, infos } = collect('assistant', true, review);
    const { def } = tool();
    const run = withApproval(gate, 'command', def).execute(
      'c1',
      { command: 'npm publish' },
      undefined,
      undefined,
      undefined as never
    );
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(infos[0].phase).toBeUndefined();
    expect(review).not.toHaveBeenCalled();
    gate.respond(infos[0].requestId, 'allow');
    await run;
  });

  it('只读工具仅在底线开启且读取密钥文件时要求确认', async () => {
    const off = collect('full', false);
    const read = tool('read');
    await withProtectedFloor(off.gate, 'read', read.def).execute(
      'r1',
      { path: '.env' },
      undefined,
      undefined,
      undefined as never
    );
    expect(off.infos).toHaveLength(0);

    const on = collect('supervised', true);
    await withProtectedFloor(on.gate, 'read', read.def).execute(
      'r2',
      { path: 'src/a.ts' },
      undefined,
      undefined,
      undefined as never
    );
    expect(on.infos).toHaveLength(0);
    const run = withProtectedFloor(on.gate, 'read', read.def).execute(
      'r3',
      { path: '/repo/.env' },
      undefined,
      undefined,
      undefined as never
    );
    await vi.waitFor(() => expect(on.infos).toHaveLength(1));
    expect(on.infos[0]).toMatchObject({
      tool: 'read',
      protected: 'secret',
      summary: 'read /repo/.env',
    });
    on.gate.respond(on.infos[0].requestId, 'deny');
    await expect(run).rejects.toThrow(/denied/);
    expect(read.execute).toHaveBeenCalledTimes(2);
  });
});

describe('bot 模式完全放行跳过受保护底线', () => {
  const tool = (name = 'bash') => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: {} });
    return {
      execute,
      def: { name, label: name, description: '', parameters: {} as never, execute },
    };
  };
  const botGate = (mode: GateMode, options: { protectedFloor: boolean; exemptFull?: boolean }) => {
    const infos: ApprovalRequestInfo[] = [];
    const gate = new ApprovalGate(
      mode,
      (info) => infos.push(info),
      () => undefined,
      {
        ...options,
        humanTimeoutMs: 600_000,
      }
    );
    return { gate, infos };
  };
  const run = (gate: ApprovalGate, command: string, def = tool().def) =>
    withApproval(gate, 'command', def).execute(
      'c1',
      { command },
      undefined,
      undefined,
      undefined as never
    );

  it('full 成员的删除 / 对外发送 / 部署直接执行，读密钥也不弹卡', async () => {
    const { gate, infos } = botGate('full', { protectedFloor: true, exemptFull: true });
    const bash = tool();
    for (const command of ['rm -rf build', 'git push --force', 'npm publish']) {
      await run(gate, command, bash.def);
    }
    const read = tool('read');
    await withProtectedFloor(gate, 'read', read.def).execute(
      'r1',
      { path: '/repo/.env' },
      undefined,
      undefined,
      undefined as never
    );
    expect(gate.protectedFloor).toBe(false);
    expect(infos).toHaveLength(0);
    expect(bash.execute).toHaveBeenCalledTimes(3);
    expect(read.execute).toHaveBeenCalledOnce();
  });

  it('非 full 成员照旧兜底：auto-edits 下受保护命令弹卡并带类别与超时', async () => {
    const { gate, infos } = botGate('auto-edits', { protectedFloor: true, exemptFull: true });
    const bash = tool();
    const pending = run(gate, 'rm -rf build', bash.def);
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(infos[0]).toMatchObject({ protected: 'delete' });
    expect(infos[0].expiresAt).toBeTypeOf('number');
    gate.respond(infos[0].requestId, 'deny');
    await expect(pending).rejects.toThrow(/denied/);
    expect(bash.execute).not.toHaveBeenCalled();
  });

  it('非 full 的 assistant 成员受保护动作仍跳过代审直接等真人', async () => {
    const review = vi.fn().mockResolvedValue({ decision: 'auto_allow' });
    const infos: ApprovalRequestInfo[] = [];
    const gate = new ApprovalGate(
      'assistant',
      (info) => infos.push(info),
      () => undefined,
      {
        review,
        protectedFloor: true,
        exemptFull: true,
      }
    );
    const pending = run(gate, 'npm publish');
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(infos[0].protected).toBeTruthy();
    expect(review).not.toHaveBeenCalled();
    gate.respond(infos[0].requestId, 'allow');
    await pending;
  });

  it('运行中切换档位即时生效：full 切到 supervised 后底线恢复', async () => {
    const { gate, infos } = botGate('full', { protectedFloor: true, exemptFull: true });
    await run(gate, 'rm -rf build');
    expect(infos).toHaveLength(0);
    gate.mode = 'supervised';
    expect(gate.protectedFloor).toBe(true);
    const pending = run(gate, 'rm -rf dist');
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(infos[0].protected).toBe('delete');
    gate.respond(infos[0].requestId, 'allow');
    await pending;
  });

  it('子会话按自身档位判断：沿用底线配置，不继承父会话的放行结果', async () => {
    const parent = botGate('full', { protectedFloor: true, exemptFull: true });
    expect(parent.gate.protectedFloor).toBe(false);
    const childInfos: ApprovalRequestInfo[] = [];
    const child = new ApprovalGate(
      'auto-edits',
      (info) => childInfos.push(info),
      () => undefined,
      parent.gate.floorOptions
    );
    expect(child.protectedFloor).toBe(true);
    const pending = run(child, 'rm -rf build');
    await vi.waitFor(() => expect(childInfos).toHaveLength(1));
    child.respond(childInfos[0].requestId, 'deny');
    await expect(pending).rejects.toThrow(/denied/);

    const strictParent = botGate('supervised', { protectedFloor: true, exemptFull: true });
    const fullChild = new ApprovalGate(
      'full',
      () => undefined,
      () => undefined,
      strictParent.gate.floorOptions
    );
    expect(strictParent.gate.protectedFloor).toBe(true);
    expect(fullChild.protectedFloor).toBe(false);
  });

  it('Code 模式（底线开启、未豁免）full 仍对受保护动作要求确认，子会话同样', async () => {
    const { gate, infos } = botGate('full', { protectedFloor: true });
    expect(gate.protectedFloor).toBe(true);
    const pending = run(gate, 'rm -rf build');
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    gate.respond(infos[0].requestId, 'allow');
    await pending;
    const child = new ApprovalGate(
      'full',
      () => undefined,
      () => undefined,
      gate.floorOptions
    );
    expect(child.protectedFloor).toBe(true);
    expect(botGate('full', { protectedFloor: false }).gate.protectedFloor).toBe(false);
  });
});

describe('ApprovalGate 等人超时', () => {
  const tool = (gate: ApprovalGate) =>
    withApproval(gate, 'command', {
      name: 'bash',
      label: 'Bash',
      description: '',
      parameters: {} as never,
      execute: vi.fn(),
    });

  it('开启时真人阶段的审批带 expiresAt；expire 后按「审批超时」拒绝且发出 resolved', async () => {
    const infos: ApprovalRequestInfo[] = [];
    const resolved: string[] = [];
    const gate = new ApprovalGate(
      'supervised',
      (info) => infos.push(info),
      (id) => resolved.push(id),
      { humanTimeoutMs: 600_000 }
    );
    const before = Date.now();
    const run = tool(gate).execute('c1', { command: 'ls' }, undefined, undefined, {} as never);
    await Promise.resolve();
    expect(infos[0].expiresAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(gate.snapshot()[0].expiresAt).toBe(infos[0].expiresAt);
    gate.expire(infos[0].requestId);
    await expect(run).rejects.toThrow(/^审批超时（10 分钟未处理）/);
    expect(resolved).toEqual([infos[0].requestId]);
    gate.expire(infos[0].requestId);
    expect(resolved).toHaveLength(1);
  });

  it('超时拒绝与用户主动拒绝文案不同', async () => {
    const gate = new ApprovalGate(
      'supervised',
      (info) => gate.respond(info.requestId, 'deny'),
      () => undefined
    );
    await expect(
      tool(gate).execute('c1', { command: 'ls' }, undefined, undefined, {} as never)
    ).rejects.toThrow('User denied this operation');
  });

  it('代审阶段不带 expiresAt，转真人后才开始计时；未开启时不带', async () => {
    const infos: ApprovalRequestInfo[] = [];
    const gate = new ApprovalGate(
      'assistant',
      (info) => infos.push(info),
      () => undefined,
      {
        humanTimeoutMs: 600_000,
        review: async () => ({ decision: 'ask_user' }),
      }
    );
    void gate.ask('bash', 'command', 'ls', undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(infos[0]).toMatchObject({ phase: 'reviewing' });
    expect(infos[0].expiresAt).toBeUndefined();
    expect(infos[1].expiresAt).toBeTypeOf('number');

    const plain = new ApprovalGate(
      'supervised',
      (info) => infos.push(info),
      () => undefined
    );
    void plain.ask('bash', 'command', 'ls', undefined);
    expect(infos[2].expiresAt).toBeUndefined();
    expect(plain.humanTimeoutMs).toBeUndefined();
  });
});
