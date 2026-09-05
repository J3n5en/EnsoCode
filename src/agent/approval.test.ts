import type { ApprovalRequestInfo } from '@shared/types/agent';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalGate } from './approval';

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

describe('ApprovalGate', () => {
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
