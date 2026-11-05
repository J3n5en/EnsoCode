import type {
  PluginSessionState,
  PluginSessionStatus,
  SessionStatusPayload,
} from '@shared/extensionPlugins/events';
import type { NodeStatus, RendererAgentEvent } from '@shared/types/agent';

interface Node {
  root: string;
  status: NodeStatus;
  asks: Set<string>;
  approvals: Set<string>;
  /** 运行中的子代理 */
  subagents: Set<string>;
}

const rootOf = (sessionId: string) => {
  const sep = sessionId.indexOf('::');
  return sep === -1 ? sessionId : sessionId.slice(0, sep);
};

/** 从 Main 的会话事件流汇总每个主会话的状态，供插件查询与 session_status 推送 */
export class SessionStateTracker {
  private readonly nodes = new Map<string, Node>();
  private readonly reported = new Map<string, PluginSessionStatus>();

  status(sessionId: string): PluginSessionStatus {
    const root = rootOf(sessionId);
    let pendingAsks = 0;
    let pendingApprovals = 0;
    let running = false;
    for (const node of this.nodes.values()) {
      if (node.root !== root) continue;
      pendingAsks += node.asks.size;
      pendingApprovals += node.approvals.size;
      if (node.status === 'running' || node.subagents.size > 0) running = true;
    }
    const state: PluginSessionState =
      this.nodes.get(root)?.status === 'failed'
        ? 'error'
        : pendingAsks + pendingApprovals > 0
          ? 'waiting'
          : running
            ? 'running'
            : 'idle';
    return { sessionId: root, state, pendingAsks, pendingApprovals };
  }

  /** 返回状态或挂起数有变化的主会话 */
  observe(event: RendererAgentEvent): SessionStatusPayload[] {
    const touched = this.apply(event);
    const changes: SessionStatusPayload[] = [];
    for (const root of touched) {
      const next = this.status(root);
      const prev = this.reported.get(root);
      if (
        prev?.state === next.state &&
        prev.pendingAsks === next.pendingAsks &&
        prev.pendingApprovals === next.pendingApprovals
      )
        continue;
      if (!prev && next.state === 'idle' && next.pendingAsks + next.pendingApprovals === 0)
        continue;
      this.reported.set(root, next);
      changes.push({ ...next, previous: prev?.state ?? 'idle' });
    }
    return changes;
  }

  private node(sessionId: string): Node {
    let node = this.nodes.get(sessionId);
    if (!node) {
      node = {
        root: rootOf(sessionId),
        status: 'idle',
        asks: new Set(),
        approvals: new Set(),
        subagents: new Set(),
      };
      this.nodes.set(sessionId, node);
    }
    return node;
  }

  private apply(event: RendererAgentEvent): Set<string> {
    if (event.type === 'worker-exited') {
      for (const node of this.nodes.values()) {
        node.status = 'failed';
        node.asks.clear();
        node.approvals.clear();
        node.subagents.clear();
      }
      return new Set([...this.nodes.values()].map((node) => node.root));
    }
    if (event.type === 'snapshot') {
      const touched = new Set<string>();
      for (const snapshot of event.sessions) {
        const node = this.node(snapshot.identity.sessionId);
        node.status = snapshot.status;
        node.asks = new Set((snapshot.pendingAsks ?? []).map((ask) => ask.requestId));
        node.approvals = new Set((snapshot.pendingApprovals ?? []).map((r) => r.requestId));
        node.subagents = new Set(
          (snapshot.subagents ?? []).filter((a) => a.status === 'running').map((a) => a.id)
        );
        touched.add(node.root);
      }
      return touched;
    }
    if (!('identity' in event) || !event.identity) return new Set();
    const id = event.identity.sessionId;
    switch (event.type) {
      case 'status':
        this.node(id).status = event.status;
        break;
      case 'turn-failed':
        this.node(id).status = 'failed';
        break;
      // 新一代就绪或会话结束：上一代的挂起请求都已作废
      case 'parent-ready':
      case 'child-ready':
      case 'parent-ended': {
        const node = this.node(id);
        node.status = 'idle';
        node.asks.clear();
        node.approvals.clear();
        node.subagents.clear();
        break;
      }
      case 'child-ended':
        if (!this.nodes.delete(id)) return new Set();
        break;
      case 'approval-request':
        this.node(id).approvals.add(event.request.requestId);
        break;
      case 'approval-resolved':
        this.node(id).approvals.delete(event.requestId);
        break;
      case 'ask-request':
        this.node(id).asks.add(event.ask.requestId);
        break;
      case 'ask-resolved':
        this.node(id).asks.delete(event.requestId);
        break;
      case 'subagent-update': {
        const subagents = this.node(id).subagents;
        if (event.agent.status === 'running') subagents.add(event.agent.id);
        else subagents.delete(event.agent.id);
        break;
      }
      default:
        return new Set();
    }
    return new Set([rootOf(id)]);
  }
}
