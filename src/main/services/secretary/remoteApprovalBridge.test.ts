import type { ApprovalRequestInfo, RendererAgentEvent, SessionIdentity } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  RemoteApprovalBridge,
  type RemoteApprovalCard,
  type RemoteApprovalSettle,
  remoteApprovalKey,
  remoteTier,
} from './remoteApprovalBridge';

const ID: SessionIdentity = { sessionId: 'conv-1', generation: 'g1' };

function request(patch: Partial<ApprovalRequestInfo> = {}): ApprovalRequestInfo {
  return {
    requestId: 'apr-1-100',
    tool: 'write',
    kind: 'file-write',
    summary: 'src/a.ts',
    ...patch,
  };
}

function harness() {
  const shown: RemoteApprovalCard[][] = [[], []];
  const settled: [string, RemoteApprovalSettle][][] = [[], []];
  const responded: [SessionIdentity, string, string][] = [];
  let respondOk = true;
  const bridge = new RemoteApprovalBridge({
    respondApproval: (identity, requestId, decision) => {
      responded.push([identity, requestId, decision]);
      return respondOk ? { ok: true } : { ok: false, error: 'worker-down' };
    },
    sinks: () =>
      [0, 1].map((index) => ({
        showApproval: (card: RemoteApprovalCard) => shown[index]?.push(card),
        settleApproval: (key: string, how: RemoteApprovalSettle) =>
          settled[index]?.push([key, how]),
      })),
    sessionTitle: (sessionId) => (sessionId === 'conv-1' ? '修登录' : undefined),
  });
  let seq = 0;
  const ask = (info: ApprovalRequestInfo, identity: SessionIdentity = ID, at = ++seq) =>
    bridge.observe({ type: 'approval-request', identity, seq: at, request: info });
  const resolved = (requestId: string, identity: SessionIdentity = ID, at = ++seq) =>
    bridge.observe({ type: 'approval-resolved', identity, seq: at, requestId });
  return {
    bridge,
    shown,
    settled,
    responded,
    ask,
    resolved,
    failRespond: () => {
      respondOk = false;
    },
  };
}

describe('remoteTier', () => {
  it('普通写文件、编辑与良性命令可以远程批', () => {
    expect(remoteTier(request())).toBe('remote');
    expect(remoteTier(request({ kind: 'file-edit', tool: 'edit' }))).toBe('remote');
    expect(remoteTier(request({ kind: 'command', tool: 'bash', summary: 'pnpm test' }))).toBe(
      'remote'
    );
  });

  it('命中底线、每次要真人、阻断型守卫、MCP 一律回桌面', () => {
    expect(remoteTier(request({ protected: 'delete' }))).toBe('desktop');
    expect(remoteTier(request({ mandatory: true }))).toBe('desktop');
    expect(remoteTier(request({ kind: 'mcp', tool: 'github_list_issues' }))).toBe('desktop');
    const guard = { ruleId: 'core.git:reset-hard', reason: 'destroys work' };
    expect(remoteTier(request({ kind: 'command', summary: 'ls', guard }))).toBe('desktop');
    expect(
      remoteTier(request({ kind: 'command', summary: 'ls', guard: { ...guard, decision: 'ask' } }))
    ).toBe('desktop');
  });

  it('只提示的守卫不挡远程', () => {
    const guard = { ruleId: 'x', reason: 'y', decision: 'warn' as const };
    expect(remoteTier(request({ kind: 'command', summary: 'ls', guard }))).toBe('remote');
  });

  it('底线关掉没标 protected 时，危险命令照样回桌面', () => {
    for (const summary of [
      'git push origin main',
      'git -C repo push',
      'cd app && git push',
      'GIT PUSH origin',
      'rm -rf build',
      'npm publish',
    ]) {
      expect(remoteTier(request({ kind: 'command', tool: 'bash', summary }))).toBe('desktop');
    }
    expect(remoteTier(request({ kind: 'command', tool: 'bash', summary: 'git status' }))).toBe(
      'remote'
    );
  });
});

describe('remoteApprovalKey', () => {
  it('16 位十六进制，同一个 id 稳定，不同 id 不同', () => {
    const key = remoteApprovalKey('apr-1-100');
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(remoteApprovalKey('apr-1-100')).toBe(key);
    expect(remoteApprovalKey('apr-2-100')).not.toBe(key);
  });
});

describe('RemoteApprovalBridge', () => {
  it('审批出现时每个渠道各收到一张带上下文的卡', () => {
    const h = harness();
    h.ask(request({ kind: 'command', tool: 'bash', summary: 'pnpm test' }));
    const card = {
      key: remoteApprovalKey('apr-1-100'),
      conversationId: 'conv-1',
      title: '修登录',
      tool: 'bash',
      kind: 'command',
      summary: 'pnpm test',
      tier: 'remote',
    };
    expect(h.shown).toEqual([[card], [card]]);
  });

  it('子会话的卡回到父会话打开，标题按父会话', () => {
    const h = harness();
    h.ask(request(), { sessionId: 'conv-1::cw-2', generation: 'g1' });
    expect(h.shown[0]?.[0]).toMatchObject({ conversationId: 'conv-1', title: '修登录' });
  });

  it('代审中、重复、过期序号的事件不发卡', () => {
    const h = harness();
    h.ask(request({ phase: 'reviewing' }), ID, 1);
    expect(h.shown[0]).toEqual([]);
    h.ask(request(), ID, 2);
    h.ask(request(), ID, 3);
    h.ask(request({ requestId: 'apr-9-1' }), ID, 2);
    expect(h.shown[0]?.map((card) => card.key)).toEqual([remoteApprovalKey('apr-1-100')]);
  });

  it('超长摘要截断', () => {
    const h = harness();
    h.ask(request({ summary: 'x'.repeat(2000) }));
    const summary = h.shown[0]?.[0]?.summary ?? '';
    expect(summary.length).toBeLessThan(600);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('应用里批完：各渠道收尾为已在别处处理，再点按钮回 settled', () => {
    const h = harness();
    h.ask(request());
    h.resolved('apr-1-100');
    const key = remoteApprovalKey('apr-1-100');
    expect(h.settled).toEqual([[[key, 'elsewhere']], [[key, 'elsewhere']]]);
    expect(h.bridge.resolve(key, 'allow', { remoteEnabled: true })).toEqual({ kind: 'settled' });
    expect(h.responded).toEqual([]);
  });

  it('未知按钮回 unknown，不调 respondApproval', () => {
    const h = harness();
    expect(h.bridge.resolve('0123456789abcdef', 'allow', { remoteEnabled: true })).toEqual({
      kind: 'unknown',
    });
    expect(h.responded).toEqual([]);
  });

  it('高危卡只能回桌面，渠道开关关着也不放行', () => {
    const h = harness();
    h.ask(request({ requestId: 'apr-1-1', protected: 'deploy' }));
    h.ask(request({ requestId: 'apr-2-1' }));
    expect(
      h.bridge.resolve(remoteApprovalKey('apr-1-1'), 'allow', { remoteEnabled: true })
    ).toEqual({ kind: 'desktop' });
    expect(
      h.bridge.resolve(remoteApprovalKey('apr-2-1'), 'allow', { remoteEnabled: false })
    ).toEqual({ kind: 'disabled' });
    expect(h.responded).toEqual([]);
    expect(h.settled).toEqual([[], []]);
  });

  it('远程批准走 respondApproval 单次放行，各渠道收尾，第二次点回 settled', () => {
    const h = harness();
    const child = { sessionId: 'conv-1::cw-2', generation: 'g7' };
    h.ask(request(), child);
    const key = remoteApprovalKey('apr-1-100');
    expect(h.bridge.resolve(key, 'allow', { remoteEnabled: true })).toEqual({
      kind: 'resolved',
      action: 'allow',
    });
    expect(h.responded).toEqual([[child, 'apr-1-100', 'allow']]);
    expect(h.settled).toEqual([[[key, 'allowed']], [[key, 'allowed']]]);
    expect(h.bridge.resolve(key, 'deny', { remoteEnabled: true })).toEqual({ kind: 'settled' });
    // 随后到的 approval-resolved 不再收尾第二次
    h.resolved('apr-1-100', child);
    expect(h.settled[0]).toHaveLength(1);
    expect(h.responded).toHaveLength(1);
  });

  it('远程拒绝传 deny', () => {
    const h = harness();
    h.ask(request());
    const key = remoteApprovalKey('apr-1-100');
    h.bridge.resolve(key, 'deny', { remoteEnabled: true });
    expect(h.responded[0]?.[2]).toBe('deny');
    expect(h.settled[0]).toEqual([[key, 'denied']]);
  });

  it('没送到 worker：回 failed，卡还挂着', () => {
    const h = harness();
    h.ask(request());
    h.failRespond();
    const key = remoteApprovalKey('apr-1-100');
    expect(h.bridge.resolve(key, 'allow', { remoteEnabled: true })).toEqual({ kind: 'failed' });
    expect(h.settled[0]).toEqual([]);
  });

  it('worker 退出：挂着的卡收尾为已失效，旧按钮回 unknown', () => {
    const h = harness();
    h.ask(request());
    h.bridge.observe({ type: 'worker-exited' });
    const key = remoteApprovalKey('apr-1-100');
    expect(h.settled[0]).toEqual([[key, 'expired']]);
    expect(h.bridge.resolve(key, 'allow', { remoteEnabled: true })).toEqual({ kind: 'unknown' });
  });

  it('会话结束只清这个会话（含子会话），换代清掉旧代的卡', () => {
    const h = harness();
    const other = { sessionId: 'conv-2', generation: 'g1' };
    h.ask(request({ requestId: 'apr-1-1' }));
    h.ask(request({ requestId: 'apr-2-1' }), { sessionId: 'conv-1::cw-2', generation: 'g1' });
    h.ask(request({ requestId: 'apr-3-1' }), other);
    h.bridge.observe({ type: 'parent-ended', identity: ID, seq: 99, reason: 'done' });
    expect(h.settled[0]?.map(([key]) => key).sort()).toEqual(
      [remoteApprovalKey('apr-1-1'), remoteApprovalKey('apr-2-1')].sort()
    );
    h.ask(request({ requestId: 'apr-4-1' }), other);
    h.ask(request({ requestId: 'apr-5-1' }), { ...other, generation: 'g2' }, 1);
    expect(h.settled[0]?.slice(2)).toEqual([
      [remoteApprovalKey('apr-3-1'), 'expired'],
      [remoteApprovalKey('apr-4-1'), 'expired'],
    ]);
    expect(h.shown[0]?.at(-1)?.key).toBe(remoteApprovalKey('apr-5-1'));
  });

  it('与审批无关的事件不出错', () => {
    const h = harness();
    h.bridge.observe({
      type: 'turn-started',
      identity: ID,
      seq: 1,
    } as unknown as RendererAgentEvent);
    expect(h.shown[0]).toEqual([]);
  });
});
