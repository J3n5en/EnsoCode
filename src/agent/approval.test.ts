import { describe, expect, it } from 'vitest';
import { ApprovalGate } from './approval';

const makeGate = (mode: 'supervised' | 'auto-edits' | 'full' = 'supervised') => {
  const requests: string[] = [];
  const resolved: string[] = [];
  const gate = new ApprovalGate(
    mode,
    (info) => requests.push(info.requestId),
    (id) => resolved.push(id)
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
