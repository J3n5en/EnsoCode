import { createHash } from 'node:crypto';
import type {
  ApprovalKind,
  ApprovalRequestInfo,
  RendererAgentEvent,
  SessionIdentity,
} from '@shared/types/agent';
import { classifyProtectedCommand } from '../../../agent/protectedActions';

/** remote：手机上可以单次批准/拒绝；desktop：只提醒，必须回电脑处理 */
export type RemoteApprovalTier = 'remote' | 'desktop';
export type RemoteApprovalAction = 'allow' | 'deny';
/** 手机上那条卡怎么收尾：手机批了 / 手机拒了 / 应用里处理了 / 会话没了 */
export type RemoteApprovalSettle = 'allowed' | 'denied' | 'elsewhere' | 'expired';

/** 发到手机上的审批卡：只带 summary 这一级的内容，和系统通知同量级 */
export interface RemoteApprovalCard {
  key: string;
  /** 「在应用里打开」回到的会话：子会话归到父会话 */
  conversationId: string;
  title?: string;
  tool: string;
  kind: ApprovalKind;
  summary: string;
  tier: RemoteApprovalTier;
}

export type RemoteApprovalResult =
  | { kind: 'unknown' }
  | { kind: 'settled' }
  | { kind: 'desktop' }
  | { kind: 'disabled' }
  | { kind: 'failed' }
  | { kind: 'resolved'; action: RemoteApprovalAction };

/** 每个秘书的联系方式服务各是一个 sink：发卡、收尾都只认 key */
export interface RemoteApprovalSink {
  showApproval(card: RemoteApprovalCard): void;
  settleApproval(key: string, how: RemoteApprovalSettle): void;
}

export interface RemoteApprovalBridgePorts {
  /** 与桌面、PWA 同一条 agentHost.respondApproval */
  respondApproval(
    identity: SessionIdentity,
    requestId: string,
    decision: RemoteApprovalAction
  ): { ok: boolean; error?: string };
  sinks(): readonly RemoteApprovalSink[];
  sessionTitle(sessionId: string): string | undefined;
}

interface Entry {
  requestId: string;
  identity: SessionIdentity;
  tier: RemoteApprovalTier;
  pending: boolean;
}

const SUMMARY_MAX_CHARS = 400;
/** 已收尾的卡留着回答「已在别处处理」，超过这个数从最早的开始丢 */
const SETTLED_KEEP = 200;
/** 底线分类器只拦强推/删分支；普通 git push 也是对外发布，远程一律不批。宁可误拦 */
const GIT_PUSH = /\bgit\b.*\bpush\b/is;

/** callback_data 限 64 字节：requestId 哈希成 16 位十六进制 */
export function remoteApprovalKey(requestId: string): string {
  return createHash('sha256').update(requestId).digest('hex').slice(0, 16);
}

/**
 * 宁缺毋滥：底线、每次要真人、阻断型守卫、MCP 都回桌面；
 * 命令再独立过一遍底线分类器，用户关了底线也不放开远程批危险命令。
 */
export function remoteTier(info: ApprovalRequestInfo): RemoteApprovalTier {
  if (info.protected || info.mandatory) return 'desktop';
  if (info.guard && info.guard.decision !== 'warn') return 'desktop';
  if (info.kind === 'mcp') return 'desktop';
  if (info.kind === 'command') {
    if (classifyProtectedCommand(info.summary) || GIT_PUSH.test(info.summary)) return 'desktop';
  }
  return 'remote';
}

function rootOf(sessionId: string): string {
  const sep = sessionId.indexOf('::');
  return sep === -1 ? sessionId : sessionId.slice(0, sep);
}

function clip(text: string): string {
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}…` : text;
}

/**
 * 远程审批的唯一事实源：只在内存里。重启后旧按钮查无此卡，回「已失效」。
 * 事件去重与过期序号沿用 ApprovalNotificationGate 的口径。
 */
export class RemoteApprovalBridge {
  private readonly entries = new Map<string, Entry>();
  private readonly sessions = new Map<string, { generation: string; seq: number }>();

  constructor(private readonly ports: RemoteApprovalBridgePorts) {}

  observe(event: RendererAgentEvent): void {
    if (event.type === 'worker-exited') {
      this.sessions.clear();
      this.expire(() => true);
      return;
    }
    if (event.type === 'parent-ended' || event.type === 'child-ended') {
      const ended = event.identity.sessionId;
      this.sessions.delete(ended);
      this.expire(({ identity }) => {
        const id = identity.sessionId;
        return id === ended || id.startsWith(`${ended}::`);
      });
      return;
    }
    if (event.type !== 'approval-request' && event.type !== 'approval-resolved') return;
    const { sessionId, generation } = event.identity;
    const session = this.sessions.get(sessionId);
    if (!session || session.generation !== generation) {
      // 换代：旧代的审批不会以同一 requestId 活下来
      if (session)
        this.expire(
          ({ identity }) => identity.sessionId === sessionId && identity.generation !== generation
        );
      this.sessions.set(sessionId, { generation, seq: event.seq });
    } else if (event.seq <= session.seq) return;
    else session.seq = event.seq;

    if (event.type === 'approval-resolved') {
      const key = remoteApprovalKey(event.requestId);
      const entry = this.entries.get(key);
      if (entry?.pending) this.settle(key, entry, 'elsewhere');
      return;
    }
    const info = event.request;
    if (info.phase === 'reviewing') return;
    const key = remoteApprovalKey(info.requestId);
    if (this.entries.has(key)) return;
    const tier = remoteTier(info);
    this.entries.set(key, {
      requestId: info.requestId,
      identity: event.identity,
      tier,
      pending: true,
    });
    const conversationId = rootOf(sessionId);
    const title = this.ports.sessionTitle(conversationId);
    const card: RemoteApprovalCard = {
      key,
      conversationId,
      ...(title ? { title } : {}),
      tool: info.tool,
      kind: info.kind,
      summary: clip(info.summary),
      tier,
    };
    for (const sink of this.ports.sinks()) sink.showApproval(card);
  }

  /** 手机按钮：只有挂着、可远程、渠道开着时才放行；其余在乐观反馈之前拒绝 */
  resolve(
    key: string,
    action: RemoteApprovalAction,
    options: { remoteEnabled: boolean }
  ): RemoteApprovalResult {
    const entry = this.entries.get(key);
    if (!entry) return { kind: 'unknown' };
    if (!entry.pending) return { kind: 'settled' };
    if (entry.tier === 'desktop') return { kind: 'desktop' };
    if (!options.remoteEnabled) return { kind: 'disabled' };
    // 远程只有单次放行：TG 上的信息不够做会话级授权
    const sent = this.ports.respondApproval(entry.identity, entry.requestId, action);
    if (!sent.ok) return { kind: 'failed' };
    this.settle(key, entry, action === 'allow' ? 'allowed' : 'denied');
    return { kind: 'resolved', action };
  }

  private settle(key: string, entry: Entry, how: RemoteApprovalSettle): void {
    entry.pending = false;
    for (const sink of this.ports.sinks()) sink.settleApproval(key, how);
    this.prune();
  }

  private expire(match: (entry: Entry) => boolean): void {
    for (const [key, entry] of [...this.entries]) {
      if (!match(entry)) continue;
      this.entries.delete(key);
      if (entry.pending) for (const sink of this.ports.sinks()) sink.settleApproval(key, 'expired');
    }
  }

  private prune(): void {
    let extra = this.entries.size - SETTLED_KEEP;
    for (const [key, entry] of this.entries) {
      if (extra <= 0) return;
      if (entry.pending) continue;
      this.entries.delete(key);
      extra--;
    }
  }
}
