import type { PluginInjectSender } from '@shared/extensionPlugins/protocol';
import {
  type DemandMilestoneKind,
  type DemandPrEventInput,
  type DemandPrEventKind,
  type DemandPrRouteResult,
  type DemandThreadPr,
  type DemandThreadSource,
  type DemandThreadStatus,
  type DemandThreadView,
  demandPrClaimKey,
  isGroupMilestoneKind,
} from '@shared/types/demandThreads';
import { type DemandThreadStore, demandMilestoneSent, getDemandThreadStore } from './demandThreads';

export interface DemandInjectInput {
  sessionId: string;
  pluginId: string;
  text: string;
  claimKey: string;
  claimLabel?: string;
  sender?: PluginInjectSender;
}

export interface DemandReplyInput {
  source: DemandThreadSource;
  text: string;
  secretaryId?: string;
}

export interface DemandThreadRouterDeps {
  store: DemandThreadStore;
  injectToSession: (
    input: DemandInjectInput
  ) => Promise<{ ok: boolean; skipped?: boolean; error?: string }>;
  replyToSource: (
    input: DemandReplyInput
  ) => Promise<{ ok: boolean; messageId?: string; error?: string }>;
}

export function nextDemandStatus(
  current: DemandThreadStatus,
  kind: DemandPrEventKind
): DemandThreadStatus {
  if (current === 'closed') return 'closed';
  if (current === 'merged') return kind === 'closed' ? 'closed' : 'merged';
  switch (kind) {
    case 'pr_opened':
      return 'pr_opened';
    case 'ci_failed':
      return 'ci_failed';
    case 'needs_human':
      return 'needs_human';
    case 'merged':
      return 'merged';
    case 'closed':
      return 'closed';
    case 'ci_passed':
      return current === 'ci_failed' ? 'pr_opened' : current;
    default:
      return current;
  }
}

function milestoneDedupeKey(event: DemandPrEventInput): string | undefined {
  if (event.kind === 'ci_failed') return event.headSha ?? event.summary ?? 'ci_failed';
  if (event.kind === 'needs_human') return event.summary ?? event.text.slice(0, 80);
  return undefined;
}

function milestoneText(event: DemandPrEventInput): string {
  const title = event.title ? ` ${event.title}` : '';
  const link = event.url ? `\n${event.url}` : '';
  const extra = event.summary ? `\n${event.summary}` : '';
  const head = `#${event.number}${title}`;
  switch (event.kind) {
    case 'pr_opened':
      return `PR 已开：${head}${link}${extra}`;
    case 'ci_failed':
      return `CI 失败：${head}${link}${extra}`;
    case 'needs_human':
      return `需要人处理：${head}${link}${extra}`;
    case 'merged':
      return `已合并：${head}${link}${extra}`;
    default:
      return head;
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : '投递失败';
}

export class DemandThreadRouter {
  private readonly inFlightMilestones = new Set<string>();
  private readonly inFlightComplete = new Set<string>();

  constructor(private readonly deps: DemandThreadRouterDeps) {}

  async routePrEvent(pluginId: string, event: DemandPrEventInput): Promise<DemandPrRouteResult> {
    const thread = this.deps.store.findByPr(event.repo, event.number);
    if (!thread) return { routed: false, reason: 'no-thread' };
    const pr: DemandThreadPr = {
      repo: event.repo,
      number: event.number,
      ...(event.url ? { url: event.url } : {}),
      ...(event.title ? { title: event.title } : {}),
      ...(event.headSha ? { headSha: event.headSha } : {}),
    };
    const updated =
      this.deps.store.updateStatus(thread.id, nextDemandStatus(thread.status, event.kind), {
        pr,
      }) ?? thread;
    const injected = await this.inject({
      sessionId: updated.sessionId,
      pluginId,
      text: event.text,
      claimKey: demandPrClaimKey(event.repo, event.number, event.kind),
      ...(event.title ? { claimLabel: event.title } : {}),
      ...(event.sender ? { sender: event.sender } : {}),
    });
    const milestone =
      thread.status === 'closed' || !isGroupMilestoneKind(event.kind)
        ? { pushed: false as const }
        : await this.pushMilestone(updated, event);
    return {
      routed: true,
      threadId: updated.id,
      sessionId: updated.sessionId,
      delivered: injected.ok && injected.skipped !== true,
      milestonePushed: milestone.pushed,
      ...(milestone.pushed ? { milestoneKind: event.kind as DemandMilestoneKind } : {}),
      ...(milestone.replyMessageId ? { replyMessageId: milestone.replyMessageId } : {}),
      ...(injected.error || milestone.error ? { error: milestone.error ?? injected.error } : {}),
    };
  }

  async onSessionGoalCompleted(
    sessionId: string,
    info?: { summary?: string; pr?: DemandThreadPr }
  ): Promise<boolean> {
    if (info?.pr) this.deps.store.bindPr({ sessionId }, info.pr);
    let sent = false;
    for (const thread of this.deps.store.findActiveBySession(sessionId)) {
      if (thread.status === 'closed' || thread.completedAt !== undefined) continue;
      if (demandMilestoneSent(thread.milestonesSent, 'merged')) continue;
      if (this.inFlightComplete.has(thread.id)) continue;
      this.inFlightComplete.add(thread.id);
      const pr = thread.pr ? ` PR #${thread.pr.number}` : '';
      const summary = info?.summary ? `：${info.summary}` : '';
      try {
        const reply = await this.reply({
          source: thread.source,
          text: `需求已完成${pr}${summary}`,
          secretaryId: thread.secretaryId,
        });
        if (!reply.ok) continue;
        this.deps.store.updateStatus(thread.id, thread.status === 'merged' ? 'merged' : 'closed');
        sent = true;
      } finally {
        this.inFlightComplete.delete(thread.id);
      }
    }
    return sent;
  }

  async onSessionNeedsHuman(
    sessionId: string,
    summary: string,
    dedupeKey?: string
  ): Promise<boolean> {
    const thread = this.deps.store.findActiveBySession(sessionId)[0];
    if (!thread) return false;
    const key = dedupeKey ?? summary;
    const current = this.deps.store.updateStatus(thread.id, 'needs_human') ?? thread;
    if (demandMilestoneSent(current.milestonesSent, 'needs_human', key)) return false;
    const flightKey = `${current.id}:needs_human:${key}`;
    if (this.inFlightMilestones.has(flightKey)) return false;
    this.inFlightMilestones.add(flightKey);
    try {
      const reply = await this.reply({
        source: current.source,
        text: `需要人处理：${summary}`,
        secretaryId: current.secretaryId,
      });
      if (!reply.ok) return false;
      return this.deps.store.recordMilestone(current.id, 'needs_human', {
        dedupeKey: key,
        summary,
        ...(reply.messageId ? { replyMessageId: reply.messageId } : {}),
      });
    } finally {
      this.inFlightMilestones.delete(flightKey);
    }
  }

  private async pushMilestone(
    thread: DemandThreadView,
    event: DemandPrEventInput
  ): Promise<{ pushed: boolean; replyMessageId?: string; error?: string }> {
    if (!isGroupMilestoneKind(event.kind)) return { pushed: false };
    const dedupeKey = milestoneDedupeKey(event);
    const kind = event.kind;
    if (demandMilestoneSent(thread.milestonesSent, kind, dedupeKey)) return { pushed: false };
    const flightKey = `${thread.id}:${kind}:${dedupeKey ?? ''}`;
    if (this.inFlightMilestones.has(flightKey)) return { pushed: false };
    this.inFlightMilestones.add(flightKey);
    try {
      const reply = await this.reply({
        source: thread.source,
        text: milestoneText(event),
        secretaryId: thread.secretaryId,
      });
      if (!reply.ok) return { pushed: false, error: reply.error ?? '回群失败' };
      this.deps.store.recordMilestone(thread.id, kind, {
        ...(dedupeKey !== undefined ? { dedupeKey } : {}),
        ...(event.summary ? { summary: event.summary } : {}),
        ...(reply.messageId ? { replyMessageId: reply.messageId } : {}),
      });
      return { pushed: true, ...(reply.messageId ? { replyMessageId: reply.messageId } : {}) };
    } finally {
      this.inFlightMilestones.delete(flightKey);
    }
  }

  private async inject(input: DemandInjectInput) {
    try {
      return await this.deps.injectToSession(input);
    } catch (error) {
      return { ok: false, error: failureMessage(error) };
    }
  }

  private async reply(input: DemandReplyInput) {
    try {
      return await this.deps.replyToSource(input);
    } catch (error) {
      return { ok: false, error: failureMessage(error) };
    }
  }
}

let singleton: DemandThreadRouter | null = null;

export function getDemandThreadRouter(): DemandThreadRouter {
  if (!singleton) {
    singleton = new DemandThreadRouter({
      store: getDemandThreadStore(),
      injectToSession: (input) => injectDemandThread(input),
      replyToSource: (input) => replyDemandThread(input),
    });
  }
  return singleton;
}

export function peekDemandThreadRouter(): DemandThreadRouter | null {
  return singleton;
}

export function setDemandThreadRouter(router: DemandThreadRouter | null): void {
  singleton = router;
}

async function injectDemandThread(input: DemandInjectInput) {
  const { getExtensionPlugins } = await import('./extensionPlugins');
  const plugins = getExtensionPlugins();
  if (!plugins) return { ok: false, error: '插件服务未就绪' };
  const result = plugins.injectOwned({
    pluginId: input.pluginId,
    sessionId: input.sessionId,
    text: input.text,
    claimKey: input.claimKey,
    ...(input.claimLabel ? { claimLabel: input.claimLabel } : {}),
    ...(input.sender ? { sender: input.sender } : {}),
  });
  return {
    ok: result.ok,
    ...(result.ok && result.skipped ? { skipped: true } : {}),
    ...(!result.ok ? { error: result.error } : {}),
  };
}

async function replyDemandThread(input: DemandReplyInput) {
  const { replyToDemandThreadSource } = await import('../ipc/secretaryContact');
  return replyToDemandThreadSource(input.source, input.text, input.secretaryId);
}
