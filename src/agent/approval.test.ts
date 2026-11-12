import type { ApprovalRequestInfo } from '@shared/types/agent';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalGate, summarizeApproval, withApproval, withProtectedFloor } from './approval';
import { takeApprovalReview } from './approvalReviewRecords';

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

const makeGate = (
  mode: GateMode = 'supervised',
  options?: { review?: ReviewFn; protectedFloor?: boolean }
) => {
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
  it('请求回调与异步 reviewer 启动前的快照都保留 reviewing，转人工后才清除', async () => {
    const infos: ApprovalRequestInfo[] = [];
    const snapshots: ApprovalRequestInfo[][] = [];
    let finish!: (value: { decision: 'ask_user' }) => void;
    const gate = new ApprovalGate(
      'assistant',
      (info) => {
        infos.push(info);
        snapshots.push(gate.snapshot());
      },
      () => {},
      {
        review: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      }
    );
    const result = gate.ask('bash', 'command', 'ls', undefined);
    expect(snapshots[0]).toEqual([infos[0]]);
    expect(gate.snapshot()[0]?.phase).toBe('reviewing');
    await Promise.resolve();
    finish({ decision: 'ask_user' });
    await vi.waitFor(() => expect(infos).toHaveLength(2));
    expect(snapshots[1]).toEqual([infos[1]]);
    expect(gate.snapshot()[0]?.phase).toBeUndefined();
    gate.respond(infos[0].requestId, 'deny');
    await expect(result).resolves.toBe('deny');
  });

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

  // grep 的 --glob 越过 .gitignore：glob 点名密钥文件触发确认时，卡片摘要要带出 glob，否则看不出要读什么
  it('grep 用 glob 指向密钥文件时要求确认，摘要带出 glob，拒绝后不执行', async () => {
    const on = collect('full', true);
    const grep = tool('grep');
    const run = withProtectedFloor(on.gate, 'read', grep.def).execute(
      'g1',
      { pattern: 'API_KEY', glob: '.env' },
      undefined,
      undefined,
      undefined as never
    );
    await vi.waitFor(() => expect(on.infos).toHaveLength(1));
    expect(on.infos[0]).toMatchObject({
      tool: 'grep',
      protected: 'secret',
      summary: 'grep --glob .env',
    });
    on.gate.respond(on.infos[0].requestId, 'deny');
    await expect(run).rejects.toThrow(/denied/);
    expect(grep.execute).not.toHaveBeenCalled();
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

describe('ApprovalGate 托管判定（#152）', () => {
  const record = { verdict: 'deny' as const, model: 'jev', allow: 0.67, ask: 0.1, block: 0.23 };

  it('托管拒绝：不弹真人卡，ask() 以交回模型的理由失败，记录挂到该工具调用', async () => {
    const infos: ApprovalRequestInfo[] = [];
    const gate = new ApprovalGate(
      'assistant',
      (info) => infos.push(info),
      () => {},
      {
        review: async () => ({ decision: 'deny', message: 'Denied: try another way.', record }),
      }
    );
    await expect(gate.ask('read', 'command', 'Read .env', undefined, 'call-deny')).rejects.toThrow(
      'Denied: try another way.'
    );
    expect(infos.map((info) => info.phase)).toEqual(['reviewing']);
    expect(gate.snapshot()).toEqual([]);
    expect(takeApprovalReview('call-deny')).toEqual(record);
    expect(takeApprovalReview('call-deny')).toBeUndefined();
  });

  it('托管放行也记录判定', async () => {
    const allow = { ...record, verdict: 'allow' as const, allow: 0.95, ask: 0.05, block: 0 };
    const gate = new ApprovalGate(
      'assistant',
      () => {},
      () => {},
      {
        review: async () => ({ decision: 'auto_allow', record: allow }),
      }
    );
    expect(await gate.ask('bash', 'command', 'ls', undefined, 'call-allow')).toBe('allow');
    expect(takeApprovalReview('call-allow')).toEqual(allow);
  });

  it('受保护动作开托管后仍强制问人，不调用判定模型', async () => {
    const review = vi.fn(async () => ({ decision: 'deny' as const, message: 'x', record }));
    const infos: ApprovalRequestInfo[] = [];
    const gate = new ApprovalGate(
      'assistant',
      (info) => infos.push(info),
      () => {},
      { review }
    );
    const pending = gate.ask(
      'read',
      'command',
      'read .env',
      undefined,
      'call-p',
      undefined,
      'secret'
    );
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(review).not.toHaveBeenCalled();
    expect(infos[0].phase).toBeUndefined();
    gate.respond(infos[0].requestId, 'deny');
    expect(await pending).toBe('deny');
  });

  it('真人点代审：受保护命令也交给判定；拒绝不执行，重复点击不重复判定', async () => {
    let finish!: (value: { decision: 'deny'; message: string }) => void;
    const review = vi.fn(
      () =>
        new Promise<{ decision: 'deny'; message: string }>((resolve) => {
          finish = resolve;
        })
    );
    const execute = vi.fn();
    const infos: ApprovalRequestInfo[] = [];
    const gate = new ApprovalGate(
      'assistant',
      (info) => infos.push(info),
      () => {},
      {
        review,
        protectedFloor: true,
      }
    );
    const pending = withApproval(gate, 'command', {
      name: 'bash',
      label: 'Bash',
      description: '',
      parameters: {} as never,
      execute,
    }).execute('c1', { command: 'rm -rf /tmp/enso-floor-test' }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(review).not.toHaveBeenCalled();
    gate.respond(infos[0].requestId, 'review');
    gate.respond(infos[0].requestId, 'review');
    await vi.waitFor(() => expect(infos.at(-1)?.phase).toBe('reviewing'));
    expect(review).toHaveBeenCalledOnce();
    finish({ decision: 'deny', message: 'Too destructive.' });
    await expect(pending).rejects.toThrow('Too destructive.');
    expect(execute).not.toHaveBeenCalled();
  });

  it('真人点代审且判定放行时才执行受保护命令', async () => {
    let finish!: (value: { decision: 'auto_allow' }) => void;
    const review = vi.fn(
      () =>
        new Promise<{ decision: 'auto_allow' }>((resolve) => {
          finish = resolve;
        })
    );
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const infos: ApprovalRequestInfo[] = [];
    const gate = new ApprovalGate(
      'assistant',
      (info) => infos.push(info),
      () => {},
      {
        review,
        protectedFloor: true,
      }
    );
    const pending = withApproval(gate, 'command', {
      name: 'bash',
      label: 'Bash',
      description: '',
      parameters: {} as never,
      execute,
    }).execute('c1', { command: 'rm -rf /tmp/enso-floor-test' }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    gate.respond(infos[0].requestId, 'review');
    await vi.waitFor(() => expect(review).toHaveBeenCalledOnce());
    finish({ decision: 'auto_allow' });
    await pending;
    expect(execute).toHaveBeenCalledOnce();
  });

  it('调整不执行命令，并要求换成更安全的命令', async () => {
    const execute = vi.fn();
    const gate = new ApprovalGate(
      'supervised',
      (info) => gate.respond(info.requestId, 'revise'),
      () => undefined
    );
    const tool = withApproval(gate, 'command', {
      name: 'bash',
      label: 'Bash',
      description: '',
      parameters: {} as never,
      execute,
    });
    await expect(
      tool.execute('c1', { command: 'rm -rf x' }, undefined, undefined, {} as never)
    ).rejects.toThrow(/safer command/);
    expect(execute).not.toHaveBeenCalled();
    expect(gate.needsApproval('command', 'bash')).toBe(true);
  });

  it('没有代审函数时，代审不放行', async () => {
    const { gate, requests } = makeGate('supervised');
    const pending = gate.ask('bash', 'command', 'rm x', undefined);
    gate.respond(requests[0], 'review');
    expect(gate.snapshot()).toHaveLength(1);
    expect(gate.snapshot()[0]?.phase).toBeUndefined();
    gate.respond(requests[0], 'deny');
    await expect(pending).resolves.toBe('deny');
  });

  it('判定失败（超时 / 报错 / 缺字段）退回人工，卡片带失败原因', async () => {
    for (const fallback of ['timeout', 'error', 'invalid'] as const) {
      const infos: ApprovalRequestInfo[] = [];
      const gate = new ApprovalGate(
        'assistant',
        (info) => infos.push(info),
        () => {},
        {
          review: async () => ({ decision: 'ask_user', fallback }),
        }
      );
      const pending = gate.ask('bash', 'command', 'ls', undefined, `call-${fallback}`);
      await vi.waitFor(() => expect(infos).toHaveLength(2));
      expect(infos[1]).toMatchObject({ reviewFallback: fallback });
      expect(infos[1].phase).toBeUndefined();
      gate.respond(infos[1].requestId, 'allow');
      expect(await pending).toBe('allow');
    }
  });
});

describe('切档即时生效：reconsider 重判挂起请求', () => {
  it('切档只放行「新档本来就不需要审批」的挂起项：auto-edits 放过文件、留下命令', async () => {
    const { gate, resolved } = makeGate('supervised');
    const edit = gate.ask('edit', 'file-edit', 'src/a.ts', undefined);
    const command = gate.ask('bash', 'command', 'make', undefined);
    gate.mode = 'auto-edits';
    gate.reconsider();
    expect(await edit).toBe('allow');
    expect(gate.snapshot()).toHaveLength(1);
    // 命令仍挂起：给一个决策收尾，避免测试留下未决 promise
    const remaining = gate.snapshot()[0];
    gate.respond(remaining.requestId, 'deny');
    expect(await command).toBe('deny');
    expect(resolved).toHaveLength(2);
  });

  it('受保护动作不随 full 放行：切到 full 仍继续等真人', async () => {
    const { gate, resolved } = makeGate('supervised');
    const pending = gate.ask(
      'bash',
      'command',
      'rm -rf /repo/src',
      undefined,
      'call-protected',
      undefined,
      'delete'
    );
    gate.mode = 'full';
    gate.reconsider();
    expect(gate.snapshot()).toHaveLength(1);
    gate.respond(gate.snapshot()[0].requestId, 'allow');
    expect(await pending).toBe('allow');
    expect(resolved).toHaveLength(1);
  });
});

describe('代审期间切档：旧档结论不再算数', () => {
  it('assistant 代审中切到 supervised，auto_allow 结论被丢弃并转人工', async () => {
    const infos: ApprovalRequestInfo[] = [];
    let release!: (value: { decision: 'auto_allow' }) => void;
    const gate = new ApprovalGate(
      'assistant',
      (info) => infos.push(info),
      () => {},
      {
        review: () =>
          new Promise<{ decision: 'auto_allow' }>((resolve) => {
            release = resolve;
          }),
      }
    );
    const pending = gate.ask('bash', 'command', 'ls', undefined, 'call-review');
    await vi.waitFor(() => expect(infos[0]?.phase).toBe('reviewing'));

    gate.mode = 'supervised';
    gate.reconsider();
    release({ decision: 'auto_allow' });

    await vi.waitFor(() => expect(infos).toHaveLength(2));
    expect(infos[1]?.phase).toBeUndefined();
    gate.respond(infos[1].requestId, 'allow');
    expect(await pending).toBe('allow');
  });
});

describe('dcg 命令守卫', () => {
  const hit = { ruleId: 'core.git:reset-hard', reason: 'destroys uncommitted changes' };
  const setup = (
    mode: GateMode,
    options: { exemptFull?: boolean; protectedFloor?: boolean } = {},
    verdict: typeof hit | null = hit
  ) => {
    const infos: ApprovalRequestInfo[] = [];
    const commandGuard = vi.fn().mockResolvedValue(verdict);
    const gate = new ApprovalGate(
      mode,
      (info) => infos.push(info),
      () => undefined,
      { ...options, commandGuard }
    );
    const execute = vi.fn().mockResolvedValue({ content: [], details: {} });
    const wrap = (name: string, kind: 'command' | 'file-edit' = 'command') =>
      withApproval(gate, kind, {
        name,
        label: name,
        description: '',
        parameters: {} as never,
        execute,
      });
    const run = (name: string, params: unknown, kind?: 'command' | 'file-edit') =>
      wrap(name, kind).execute('c1', params as never, undefined, undefined, undefined as never);
    return { gate, infos, commandGuard, execute, run };
  };

  it('full 档命中也强制真人确认，卡片带 destructive 类别与原因；拒绝则不执行', async () => {
    const { gate, infos, commandGuard, execute, run } = setup('full');
    const pending = run('powershell', { command: 'Remove-Item -Recurse x' });
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(commandGuard).toHaveBeenCalledWith('powershell', 'Remove-Item -Recurse x', undefined);
    expect(infos[0]).toMatchObject({ protected: 'destructive', guard: hit });
    gate.respond(infos[0].requestId, 'allowSession');
    await pending;
    expect(execute).toHaveBeenCalledOnce();
    const again = run('powershell', { command: 'Remove-Item -Recurse y' });
    await vi.waitFor(() => expect(infos).toHaveLength(2));
    gate.respond(infos[1].requestId, 'deny');
    await expect(again).rejects.toThrow(/denied/);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('未命中按原档位放行；非命令工具不调用守卫', async () => {
    const { infos, commandGuard, execute, run } = setup('full', {}, null);
    await run('bash', { command: 'ls' });
    expect(infos).toHaveLength(0);
    expect(execute).toHaveBeenCalledOnce();
    const edits = setup('full');
    await edits.run('edit', { path: '/repo/a.ts' }, 'file-edit');
    expect(edits.commandGuard).not.toHaveBeenCalled();
    expect(commandGuard).toHaveBeenCalledOnce();
  });

  it('底线已判出类别时保留原类别并附带原因', async () => {
    const { gate, infos, run } = setup('supervised', { protectedFloor: true });
    const pending = run('bash', { command: 'rm -rf build' });
    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(infos[0]).toMatchObject({ protected: 'delete', guard: hit });
    gate.respond(infos[0].requestId, 'allow');
    await pending;
  });

  it('bot 完全放行豁免守卫；子会话经 floorOptions 继承守卫', async () => {
    const bot = setup('full', { protectedFloor: true, exemptFull: true });
    await bot.run('bash', { command: 'git reset --hard' });
    expect(bot.infos).toHaveLength(0);
    expect(bot.commandGuard).not.toHaveBeenCalled();

    const parent = setup('supervised');
    const childInfos: ApprovalRequestInfo[] = [];
    const child = new ApprovalGate(
      'full',
      (info) => childInfos.push(info),
      () => undefined,
      parent.gate.floorOptions
    );
    const pending = withApproval(child, 'command', {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: {} as never,
      execute: vi.fn(),
    }).execute(
      'c2',
      { command: 'git reset --hard' } as never,
      undefined,
      undefined,
      undefined as never
    );
    await vi.waitFor(() => expect(childInfos).toHaveLength(1));
    child.respond(childInfos[0].requestId, 'deny');
    await expect(pending).rejects.toThrow(/denied/);
  });
});

describe('无人值守：需要审批的动作直接拒绝，不建 pending（对齐 factory）', () => {
  const tool = (execute: () => Promise<never>) => ({
    name: 'bash',
    label: 'Bash',
    description: '',
    parameters: {} as never,
    execute,
  });

  it('开关打开时 ask 不发请求、不建 pending，按「没人能批准」拒绝', async () => {
    const { gate, requests } = makeGate('supervised');
    gate.autoReject = true;
    await expect(gate.ask('bash', 'command', 'npm run build', undefined)).resolves.toBe(
      'no-approver'
    );
    expect(requests).toHaveLength(0);
    expect(gate.snapshot()).toHaveLength(0);
  });

  it('拒绝文案点名动作、说没人能批准、要求别重试并给替代做法', async () => {
    const { gate } = makeGate('supervised');
    gate.autoReject = true;
    const execute = vi.fn();
    const wrapped = withApproval(gate, 'command', tool(execute as never));
    const error = await wrapped
      .execute('call-1', { command: 'git push' }, undefined, undefined, {} as never)
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Bash/);
    expect((error as Error).message).toMatch(/no user available to approve/i);
    expect((error as Error).message).toMatch(/Do not retry/i);
    expect((error as Error).message).toMatch(/needs no approval/i);
    // 「继续干活」在主位，「停下」只留给不可逆决定
    expect((error as Error).message).toMatch(/most reasonable assumption and continue/i);
    expect((error as Error).message).toMatch(/unavoidable and irreversible/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('full 档命中受保护底线时也是拒绝而不是等人', async () => {
    const { gate, requests } = makeGate('full', { protectedFloor: true });
    gate.autoReject = true;
    expect(gate.needsApproval('command', 'bash')).toBe(false);
    await expect(
      gate.ask('bash', 'command', 'rm -rf /repo/src', undefined, 'c1', undefined, 'delete')
    ).resolves.toBe('no-approver');
    expect(requests).toHaveLength(0);
    const message = await withApproval(gate, 'command', tool(vi.fn() as never))
      .execute('c2', { command: 'rm -rf /repo/src' }, undefined, undefined, {} as never)
      .catch((e: Error) => e);
    expect((message as Error).message).toMatch(/no user available to approve/i);
  });

  it('auto-edits：改文件照跑，命令被拒（开关只改「要确认时怎么办」）', async () => {
    const { gate } = makeGate('auto-edits');
    gate.autoReject = true;
    const execute = vi.fn().mockResolvedValue({ content: [] });
    const edit = withApproval(gate, 'file-edit', {
      name: 'edit',
      label: 'Edit',
      description: '',
      parameters: {} as never,
      execute,
    });
    await edit.execute('c1', { path: '/repo/a.ts' }, undefined, undefined, {} as never);
    expect(execute).toHaveBeenCalledTimes(1);
    const command = withApproval(gate, 'command', tool(vi.fn() as never));
    await expect(
      command.execute('c2', { command: 'make' }, undefined, undefined, {} as never)
    ).rejects.toThrow(/no user available to approve/i);
  });

  it('assistant 档代审：auto_allow 照放，代审要问人时改为拒绝', async () => {
    const asked = makeGate('assistant', {
      review: async () => ({ decision: 'ask_user' as const }),
    });
    asked.gate.autoReject = true;
    await expect(asked.gate.ask('bash', 'command', 'ls', undefined)).resolves.toBe('no-approver');
    // 代审阶段会发一张「代审中」卡片，但不发需要人点的请求
    expect(asked.gate.snapshot()).toHaveLength(0);

    const allowed = makeGate('assistant', {
      review: async () => ({ decision: 'auto_allow' as const }),
    });
    allowed.gate.autoReject = true;
    await expect(allowed.gate.ask('bash', 'command', 'ls', undefined)).resolves.toBe('allow');
  });

  it('assistant 档没配代审模型：无人值守下不退回等人，直接拒绝', async () => {
    const { gate, requests } = makeGate('assistant');
    gate.autoReject = true;
    await expect(gate.ask('bash', 'command', 'ls', undefined)).resolves.toBe('no-approver');
    expect(requests).toHaveLength(0);
    expect(gate.snapshot()).toHaveLength(0);
  });

  it('关掉开关后回到等人；打开时挂起的卡片立即按拒绝收尾', async () => {
    const { gate, requests } = makeGate('supervised');
    const pending = gate.ask('bash', 'command', 'npm test', undefined);
    expect(requests).toHaveLength(1);
    gate.autoReject = true;
    gate.reconsider();
    await expect(pending).resolves.toBe('no-approver');

    gate.autoReject = false;
    const again = gate.ask('bash', 'command', 'npm test', undefined);
    expect(requests).toHaveLength(2);
    gate.respond(gate.snapshot()[0].requestId, 'allow');
    await expect(again).resolves.toBe('allow');
  });
});
