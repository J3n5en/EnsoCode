import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isSkipReply } from '../../../shared/bots/router';
import { checkFailureText, checkPassed } from '../../../shared/bots/taskCheck';
import {
  buildDelegationGroupContext,
  DELEGATION_CONTEXT_LIMIT,
  delegationContextVisible,
} from '../../../shared/bots/transcript';
import type { ProjectedMessage } from '../../../shared/types/agent';
import {
  type BotPermissions,
  botNameKey,
  DELEGATION_APPENDS_MAX,
  DELEGATION_BLOCKED_NEED_MAX,
  DELEGATION_BLOCKED_STOP_MINUTES,
  DELEGATION_NOTE_MAX,
  DELEGATION_TIMEOUT_MINUTES,
  type Delegation,
  type DelegationRetryBy,
  type DelegationTrigger,
  type GroupEntry,
  type TaskCheck,
} from '../../../shared/types/bot';
import type { BotEvent, BotSendResult } from '../../../shared/types/botIpc';
import { BOT_BUDGET_ERROR } from '../../../shared/usage/botUsage';
import {
  BOT_BLOCKED_STOP,
  type BotAuthorityPort,
  type BotDeliverResult,
  type BotSessionHost,
  type BotTurnFinished,
} from './botSessionHost';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';
import {
  AUTO_RETRY_MAX,
  type AutoRetryKind,
  isActiveDelegation as active,
  autoRetryKind,
  batchDeliveryId,
  batchKey,
  batchResultText,
  batchWaitingNotice,
  DELEGATOR_RETRY_LIMIT,
  defaultAutoRetryDelayMs,
  delegationBatches,
  delegationOwner,
  delegationResultBody,
  delegatorRetries,
  escapeXml,
  pendingAutoRetry,
  supersededIds,
  trailingAutoRetries,
  unfinishedDownstream,
} from './delegationBatch';
import { delegatedBotPermissions, delegationPolicy } from './delegationPolicy';
import type { DelegationStore } from './delegationStore';
import type { TaskGate } from './groupTasks';
import { previousRunsText } from './previousRuns';
import { rewoundDelegations } from './rewind';

interface Deps {
  bots: BotStore;
  chats: BotChatStore;
  authority: BotAuthorityPort;
  host: BotSessionHost;
  store: DelegationStore;
  emit: (event: BotEvent) => void;
  /** 一分钟的毫秒数，测试用来压缩时限 */
  minuteMs?: number;
  autoRetryDelayMs?: (kind: AutoRetryKind, attempt: number) => number;
  /** 群任务看板联动：taskId 校验与每次落盘后的状态同步 */
  /** 群任务看板联动：taskId 校验、自动建卡与每次落盘后的状态同步 */
  tasks?: {
    gate(
      chatId: string | null,
      ref: string,
      parentBotId: string,
      targetBotId?: string,
      human?: boolean
    ): TaskGate;
    open(
      chatId: string,
      botId: string,
      text: string,
      check?: TaskCheck
    ): { taskId: string; seq: number } | undefined;
    discard(chatId: string, taskId: string): void;
    sync(record: Delegation, nestedIn?: string): void;
  };
  /** 子会话当前分支消息（验收读最终工具结果） */
  sessionMessages?: (conversationId: string) => Promise<readonly ProjectedMessage[]>;
  deliverGroupResult?: (
    record: Delegation,
    text: string,
    deliveryId: string,
    /** 本次回传的整批委派：其结果条目已在 text 里给过全文，群增量不再重复 */
    batch: readonly Delegation[]
  ) => Promise<BotSendResult>;
}
export interface DelegateInput {
  to: string;
  task: string;
  context?: string;
  /** 看板任务（#N 或 id）；委派创建 / 终态同步任务状态 */
  taskId?: string;
  /** 期望时限（分钟），不超过目标成员的委派时限 */
  deadlineMinutes?: number;
  /** 父回合被停止 / 中断后仍继续 */
  keep?: boolean;
  /** 验收条件；不传时沿用关联看板任务的 */
  check?: TaskCheck;
}
/** 追加回执：accepted = 已进模型；deferred = 改排在本次执行的下一回合（或 10 秒内没回执）；failed = 没送达 */
export type AppendDelivery = 'accepted' | 'deferred' | 'failed';
export type DelegateResult =
  | {
      ok: true;
      delegationId: string;
      taskId?: string;
      /** 并入了同一发起会话在本任务上排队 / 执行中的那次执行 */
      merged?: true;
      delivery?: AppendDelivery;
      warning?: string;
    }
  | { ok: false; error: string };
export type DelegationRetryMode = 'resume' | 'restart';
export type DelegatorRetryResult =
  | { ok: true; delegationId: string; retriesLeft: number; warning?: string }
  | { ok: false; error: string };

/** 续跑没成但会话本身没坏：照常记失败，不退回从头 */
const RESUME_TRANSIENT = new Set(['session-busy', 'disabled', BOT_BUDGET_ERROR]);

interface Resume {
  conversationId: string;
  /** 验收没过：在原会话补一条未通过原因，而不是从最后一步续跑 */
  checkFailed: boolean;
  /** 委派人重试附的补充说明：作为一条新消息补进原会话，而不是原样重跑最后一步 */
  note?: string;
  /** 原子会话已收到的群背景水位；旧记录没有时按首次处理 */
  groupContextSeq?: number;
}

/** 投递任务时的看板信息：#N、是否接着原会话、改派时带的退回理由 */
interface TaskInfo {
  seq?: number;
  incremental?: boolean;
  returnReason?: string;
}

const RECEIPT_MS = 10_000;

interface TurnOutcome {
  ok: boolean;
  text: string;
  error?: string;
  /** 产出结果的子会话回合（结果入群定位用） */
  turnId?: string;
  /** 瞬态失败（可自动重试） */
  transient?: true;
}

/** 执行结束时还没跑完的追加一律记失败 */
const closeAppends = (record: Delegation): Pick<Delegation, 'appends'> =>
  record.appends?.some((item) => item.ok === undefined)
    ? {
        appends: record.appends.map((item) =>
          item.ok === undefined ? { ...item, ok: false } : item
        ),
      }
    : {};

const appendId = (recordId: string, input: Pick<DelegateInput, 'task' | 'context'>) =>
  `append:${recordId}:${createHash('sha256')
    .update(`${input.task}\0${input.context ?? ''}`)
    .digest('hex')
    .slice(0, 16)}`;

const samePermissions = (a: BotPermissions | undefined, b: BotPermissions) =>
  !!a &&
  a.tools === b.tools &&
  a.approvalMode === b.approvalMode &&
  [...a.skillIds].sort().join('\n') === [...b.skillIds].sort().join('\n') &&
  [...a.mcpServerIds].sort().join('\n') === [...b.mcpServerIds].sort().join('\n');

export class DelegationService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 登记卡住后等本轮收尾的软停止计时 */
  private readonly blockTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 卡住时由排队投递转成的下一次执行：自己没有投递，排队的投递都没跑起来就记失败 */
  private readonly rollovers = new Set<string>();
  /** 已排定的自动重试；只在内存，重启后按记录里的 autoRetryAt 重排 */
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delivering = new Set<string>();
  /**
   * 带群背景、已被宿主接受但还没确认被子会话消费的投递（键见 contextKey）。只在内存：
   * 重启时仍在队列里的投递随之作废，水位保持原样，下次续跑再补。
   */
  private readonly pendingContext = new Map<string, { recordId: string; cursor: number }>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeDiscard: () => void;
  private readonly unsubscribeStarted: () => void;
  private readonly unsubscribeDeferred: () => void;
  /** 原回合已结束、还在等追加跑完的执行：先记下回合结果 */
  private readonly outcomes = new Map<string, TurnOutcome>();
  /** 已进模型、所在回合还没结束的追加 */
  private readonly accepted = new Set<string>();
  private readonly receipts = new Map<string, AppendDelivery>();
  private readonly receiptWaiters = new Map<string, Set<(state: AppendDelivery) => void>>();
  /** 正在结算（验收读会话中）的执行：期间的回合事件不再改结果 */
  private readonly settling = new Set<string>();
  /** 发起会话不同的同任务同成员：排在 after 那次执行之后，结束后才投递 */
  private readonly held = new Map<
    string,
    { after: string; run: () => Promise<void>; appends: (() => Promise<void>)[] }
  >();
  private readonly aborting = new Map<string, Promise<void>>();
  private disposed = false;
  private discarding = false;

  constructor(private readonly deps: Deps) {
    this.unsubscribeStarted = deps.host.onDeliveryStarted((event) => {
      // 先推进群背景水位：下面按最新记录改写 waiting，不能用推进前的快照覆盖
      this.consumeContext(this.contextKey(event.conversationId, event.deliveryId));
      // 等待下层的第一层被唤醒的一轮开始了：不再处于等待
      const waiting = delegationOwner(deps.store.list(), event.conversationId);
      if (waiting?.waiting && active(waiting)) {
        const { waiting: _waiting, ...rest } = waiting;
        this.save(rest);
      }
      const batch = delegationBatches(
        deps.store.list().filter((record) => record.parentConversationId === event.conversationId)
      ).find((items) => batchDeliveryId(items) === event.deliveryId);
      if (batch && !batch.some(active)) this.delivered(batch);
      const owner = this.appendOwner(event.conversationId, event.deliveryId);
      if (owner) {
        this.accepted.add(event.deliveryId);
        this.receipt(event.deliveryId, 'accepted');
      }
    });
    this.unsubscribeDeferred = deps.host.onDeliveryDeferred((event) => {
      if (this.appendOwner(event.conversationId, event.deliveryId))
        this.receipt(event.deliveryId, 'deferred');
    });
    this.unsubscribeDiscard = deps.host.onDiscard((scope) => {
      // 级联取消不是“批次里有人结束”，不写等待提示
      this.discarding = true;
      try {
        for (const record of deps.store.list()) {
          if (
            (scope.chatId && record.chatId === scope.chatId) ||
            (scope.botId &&
              (record.parentBotId === scope.botId || record.targetBotId === scope.botId)) ||
            (scope.conversationId && record.parentConversationId === scope.conversationId)
          )
            this.cancel(record.id);
        }
      } finally {
        this.discarding = false;
      }
    });
    for (const record of deps.store.list()) {
      if (!active(record)) continue;
      // 这一轮已结束、在等下层结果：不算中断，继续等（时限从重启时重新起算）；下层自己的中断按各自规则自动续跑。
      // 下层结果其实已写进子会话（Main 未确认开始就崩溃）的，由 deliverPending 认出后经 integrating 标中断续跑；
      // 下层全部被外部作废的，才由 settleNested 按暂存的输出判定
      if (record.state === 'running' && record.waiting) {
        this.arm({ ...record, startedAt: Date.now() });
        continue;
      }
      // 登记过卡住的按卡住收尾，其余记中断（中断可按规则排定自动重试）
      if (record.blocked) {
        this.save({
          ...record,
          ...closeAppends(record),
          state: 'blocked',
          finishedAt: Date.now(),
        });
        continue;
      }
      const interrupted: Delegation = {
        ...record,
        ...closeAppends(record),
        state: 'failed',
        failure: 'interrupted',
        finishedAt: Date.now(),
      };
      const delay = this.autoRetryDelay(interrupted);
      this.save(
        delay === undefined ? interrupted : { ...interrupted, autoRetryAt: Date.now() + delay }
      );
    }
    // 完成后、结果入群前崩溃：在回传之前补写（或从时间线回填 resultSeq）；只认待入群标记，旧数据不补发
    for (const record of deps.store.list()) if (record.pendingResultEntry) this.postResult(record);
    // 等待自动重试期间重启：按持久化的时刻重排（过点的立即执行）
    const records = deps.store.list();
    for (const record of records)
      if (pendingAutoRetry(record, records)) this.scheduleAutoRetry(record);
    this.unsubscribe = deps.host.onTurnFinished((event) => {
      if (event.stopped && event.turnKey) this.stopBatch(event.conversationId, event.turnKey);
      if (event.delegationId) this.turnEnded(event);
      queueMicrotask(() => {
        void this.deliverPending();
      });
    });
    queueMicrotask(() => {
      void this.deliverPending();
    });
  }

  private upstreamBots(record: Delegation): Set<string> {
    const ids = new Set<string>();
    for (let item: Delegation | undefined = record; item && !ids.has(item.parentBotId); ) {
      ids.add(item.parentBotId);
      item = this.deps.authority.conversation(item.parentConversationId)?.bot?.delegationId
        ? this.executionOf(item.parentConversationId)
        : undefined;
    }
    return ids;
  }

  /** 同一轮发起的委派共享 batchId（父会话轮次键），结果齐了合并回传；standalone 自成一批 */
  delegate(
    parentConversationId: string,
    input: DelegateInput,
    options: {
      standalone?: boolean;
      /** 自动重试沿用原批次：等它有结果再和同批其他委派一起回传 */
      batchId?: string;
      retryOf?: string;
      retryBy?: DelegationRetryBy;
      retryNote?: string;
      resume?: Resume;
      trigger?: DelegationTrigger;
      /** 不续用任务会话（手动「从头重试」） */
      fresh?: boolean;
      /** 人在任务卡上答复：不受连续卡住次数限制 */
      human?: boolean;
    } = {}
  ): DelegateResult {
    if (this.disposed) return { ok: false, error: 'disabled' };
    const conversation = this.deps.authority.conversation(parentConversationId);
    let parent = this.deps.host.effectiveBot(parentConversationId);
    const target = this.deps.bots
      .list()
      .find((bot) => bot.id === input.to || botNameKey(bot.name) === botNameKey(input.to));
    if (!conversation?.bot || conversation.lifecycle === 'ended' || !parent)
      return { ok: false, error: 'Parent bot session unavailable.' };
    if (!target) return { ok: false, error: `Unknown member: ${input.to}` };
    if (!input.task.trim()) return { ok: false, error: 'Task must not be empty.' };
    const deadline = input.deadlineMinutes;
    if (deadline !== undefined && !(Number.isFinite(deadline) && deadline > 0))
      return { ok: false, error: 'deadlineMinutes must be a positive number.' };
    const limit = target.delegationTimeoutMinutes ?? DELEGATION_TIMEOUT_MINUTES;
    const timeoutMinutes = Math.min(deadline ?? limit, limit);
    // 子会话可能先后挂多次执行：按最新一次算祖先
    const ancestor = conversation.bot.delegationId
      ? this.executionOf(parentConversationId)
      : undefined;
    if (conversation.bot.delegationId && !ancestor)
      return { ok: false, error: 'Parent delegation record unavailable.' };
    if (ancestor) {
      // 重启后 effectiveBot 回落到原始档案，审批档仍按祖先委派快照收紧
      parent = delegatedBotPermissions(
        { ...parent, approvalMode: ancestor.effectivePermissions?.approvalMode ?? 'supervised' },
        parent
      );
    }
    // 结果本来就会自动回传给上游，往回委派只会绕圈
    if (ancestor && this.upstreamBots(ancestor).has(target.id))
      return {
        ok: false,
        error: `${target.name} delegated this work to you; your final reply is returned to them automatically.`,
      };
    const depth = (ancestor ? ancestor.depth : 0) + 1;
    const chatId = conversation.bot.chatId ?? (ancestor ? ancestor.chatId : null);
    const chat = chatId ? this.deps.chats.get(chatId) : undefined;
    if (chatId && (!chat || chat.archivedAt !== undefined))
      return { ok: false, error: 'Parent chat unavailable.' };
    const count = this.deps.store
      .list()
      .filter(
        (record) => record.parentConversationId === parentConversationId && active(record)
      ).length;
    const gate =
      input.taskId === undefined
        ? undefined
        : (this.deps.tasks?.gate(chatId, input.taskId, parent.id, target.id, options.human) ?? {
            ok: false as const,
            error: 'Tasks are only available in group chats.',
          });
    // 目标成员在本任务上还有排队 / 执行中的执行：同一发起会话并入，否则排在它之后
    const current = gate?.ok && gate.active ? this.deps.store.get(gate.active) : undefined;
    const busy = current && active(current) ? current : undefined;
    // 本会话排在它后面的下一次执行也算同一次（还没投递）
    const queuedNext = busy
      ? this.deps.store
          .list()
          .find(
            (record) =>
              this.held.has(record.id) &&
              record.parentConversationId === parentConversationId &&
              record.taskId === busy.taskId &&
              record.targetBotId === target.id
          )
      : undefined;
    const merge = busy?.parentConversationId === parentConversationId ? busy : queuedNext;
    const error = delegationPolicy(
      parent,
      target,
      depth,
      merge ? 0 : count,
      chat?.kind === 'group' ? chat.members : undefined
    );
    if (error) return { ok: false, error };
    if (gate && !gate.ok) return gate;
    if (merge && gate?.ok) return this.append(merge, input, parent.name, gate.seq, limit);
    const after = merge ? undefined : busy;
    let task: Omit<Extract<TaskGate, { ok: true }>, 'ok'> | undefined;
    let opened = false;
    let check = input.check;
    if (gate?.ok) {
      task = gate;
      check ??= gate.check;
    } else if (
      chatId &&
      chat?.kind === 'group' &&
      depth === 1 &&
      !options.retryOf &&
      !options.resume
    ) {
      task = this.deps.tasks?.open(chatId, parent.id, input.task, check);
      opened = task !== undefined;
    }
    const taskId = task?.taskId;
    const id = randomUUID();
    const batchId =
      options.batchId ??
      (options.standalone ? undefined : this.deps.host.turnKey(parentConversationId));
    const projectId = conversation.projectId;
    // 同一任务同一成员才续会话：会话由看板按任务真实 id + 成员给出，这里再核对归属与可用性
    const session = after?.childConversationId ?? task?.session;
    const reuse =
      !options.resume &&
      !options.fresh &&
      task &&
      session &&
      this.reusable(session, target.id, projectId, task.taskId, after !== undefined)
        ? session
        : undefined;
    const continued = options.resume?.conversationId ?? reuse;
    const child = continued
      ? this.deps.authority.conversation(continued)
      : this.newChild(projectId, target.id, id);
    const effective = delegatedBotPermissions(parent, target);
    const permissions: BotPermissions = {
      tools: effective.tools,
      approvalMode: effective.approvalMode,
      skillIds: effective.skillIds,
      mcpServerIds: effective.mcpServerIds,
    };
    const previous = continued ? this.executionOf(continued) : undefined;
    // 活实例可能是回送子委派结果时按只读重新拉起的：工具或审批档对不上也要重启
    const live = continued ? this.deps.host.effectiveBot(continued) : undefined;
    const respawn =
      previous !== undefined &&
      (!samePermissions(previous.effectivePermissions, permissions) ||
        (live !== undefined &&
          (live.tools !== permissions.tools || live.approvalMode !== permissions.approvalMode)));
    const trigger: DelegationTrigger =
      options.trigger ?? (options.retryOf ? 'retry' : (task?.trigger ?? 'delegate'));
    // 群主再派给失败的原执行人：就是对那次失败执行的重试
    const retryOf =
      options.retryOf ??
      (trigger === 'retry' && previous?.state === 'failed' && previous.taskId === taskId
        ? previous.id
        : undefined);
    // 挂看板任务的执行（深度 1）才有 report_blocked
    const origin = {
      parentConversationId,
      chatId,
      ...(taskId && depth === 1 ? { task: true as const } : {}),
    };
    if (!child || !this.deps.host.registerDelegation(child.conversationId, effective, origin)) {
      if (opened && chatId && taskId) this.deps.tasks?.discard(chatId, taskId);
      return { ok: false, error: 'Delegation workspace unavailable.' };
    }
    const record: Delegation = {
      id,
      parentConversationId,
      parentBotId: parent.id,
      targetBotId: target.id,
      chatId,
      task: input.task,
      context: (input.context ?? '').slice(0, 8000),
      childConversationId: child.conversationId,
      state: 'queued',
      depth,
      createdAt: Date.now(),
      effectivePermissions: permissions,
      ...(batchId ? { batchId } : {}),
      ...(taskId ? { taskId } : {}),
      // 返工 / 追加不挂 retryOf：验收只认本次执行开始后的证据
      ...(retryOf ? { retryOf } : {}),
      ...(options.retryBy ? { retryBy: options.retryBy } : {}),
      ...(options.retryNote ? { retryNote: options.retryNote.slice(0, DELEGATION_NOTE_MAX) } : {}),
      ...(input.keep ? { keep: true } : {}),
      ...(check ? { check: { kind: check.kind, text: check.text } } : {}),
      timeoutMinutes,
      trigger,
      // 续跑沿用原子会话：先继承已送过的群背景水位，送出新增后再推进
      ...(options.resume?.groupContextSeq !== undefined
        ? { groupContextSeq: options.resume.groupContextSeq }
        : {}),
    };
    this.save(record);
    const info: TaskInfo = {
      ...(task ? { seq: task.seq } : {}),
      ...(reuse ? { incremental: true } : {}),
      ...(task?.returnReason && trigger === 'delegate' ? { returnReason: task.returnReason } : {}),
    };
    const freshChild = () => {
      const fresh = this.newChild(projectId, target.id, id);
      return fresh && this.deps.host.registerDelegation(fresh.conversationId, effective, origin)
        ? fresh.conversationId
        : undefined;
    };
    const dispatch = async () => {
      // 权限或工具变了：先释放空闲实例，下次开工按新配置和原 jsonl 重新 spawn（不走停止）
      if (respawn && continued) await this.deps.host.releaseIdle(continued);
      const sent = options.resume
        ? await this.resume(record, options.resume, freshChild, parent.name, info)
        : await this.sendTask(record, parent.name, info);
      const latest = this.deps.store.get(id);
      if (!latest || !active(latest)) return;
      if (!sent.ok) this.finish(latest, 'failed', 'error', undefined, sent.error);
      else if (!sent.queued) this.started(latest);
    };
    const run = () =>
      dispatch().catch((cause) => {
        const latest = this.deps.store.get(id);
        if (latest && active(latest))
          this.finish(latest, 'failed', 'error', undefined, String(cause));
      });
    if (after) {
      // 等上一次执行结束（含它被停止时的收尾）再投递，避免进到它的回合里
      const entry = {
        after: after.id,
        appends: [] as (() => Promise<void>)[],
        run: async () => {
          await this.aborting.get(after.childConversationId);
          await run();
          for (const send of entry.appends) await send();
        },
      };
      this.held.set(id, entry);
    } else void run();
    const warnings = [
      ...((input.context?.length ?? 0) > 8000 ? ['Context truncated to 8000 characters.'] : []),
      ...(deadline !== undefined && deadline > limit
        ? [`Deadline capped at ${limit} minutes (${target.name}'s delegation limit).`]
        : []),
      ...(after
        ? [
            `${target.name} is still on task #${task?.seq} for another conversation; this was queued as the next run and starts after that run ends.`,
          ]
        : []),
    ];
    return {
      ok: true,
      delegationId: id,
      ...(task ? { taskId: `#${task.seq}` } : {}),
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    };
  }

  /** 工具入口：并入执行中的执行时最多等 10 秒回执 */
  async delegateAndConfirm(
    parentConversationId: string,
    input: DelegateInput
  ): Promise<DelegateResult> {
    const result = this.delegate(parentConversationId, input);
    if (!result.ok || !result.merged) return result;
    const id = appendId(result.delegationId, input);
    const known = this.receipts.get(id);
    const delivery =
      known === 'accepted' || known === 'failed'
        ? known
        : await new Promise<AppendDelivery>((resolve) => {
            const waiters = this.receiptWaiters.get(id) ?? new Set();
            const wake = (state: AppendDelivery) => {
              clearTimeout(timer);
              waiters.delete(wake);
              resolve(state);
            };
            const timer = setTimeout(() => wake(this.receipts.get(id) ?? 'deferred'), RECEIPT_MS);
            timer.unref?.();
            waiters.add(wake);
            this.receiptWaiters.set(id, waiters);
            if (known) wake(known);
          });
    return { ...result, delivery };
  }

  /** 同一发起会话追加到本任务排队 / 执行中的执行：不建新记录，steer 进同一子会话 */
  private append(
    record: Delegation,
    input: DelegateInput,
    from: string,
    seq: number,
    limit: number
  ): DelegateResult {
    const deliveryId = appendId(record.id, input);
    const merged = {
      ok: true as const,
      delegationId: record.id,
      taskId: `#${seq}`,
      merged: true as const,
    };
    // 同一追加重发不重复执行；之前没送达的才重新投递
    const again = record.appends?.find((item) => item.deliveryId === deliveryId);
    if (again && again.ok !== false) return merged;
    if (!again && (record.appends?.length ?? 0) >= DELEGATION_APPENDS_MAX)
      return {
        ok: false,
        error: `This run already has ${DELEGATION_APPENDS_MAX} appended requests; wait for its result.`,
      };
    const minute = this.deps.minuteMs ?? 60_000;
    const now = Date.now();
    const wanted = Math.min(input.deadlineMinutes ?? limit, limit);
    const before = record.timeoutMinutes ?? DELEGATION_TIMEOUT_MINUTES;
    // 到期时刻取较晚者；排队中还没起算，只取较长的期限
    const timeoutMinutes =
      record.startedAt === undefined
        ? Math.max(before, wanted)
        : Math.max(before, Math.ceil((now + wanted * minute - record.startedAt) / minute));
    const batchId = this.deps.host.turnKey(record.parentConversationId) ?? record.batchId;
    const next: Delegation = {
      ...record,
      appends: again
        ? (record.appends ?? []).map((item) =>
            item === again ? { at: now, text: input.task, deliveryId } : item
          )
        : [...(record.appends ?? []), { at: now, text: input.task, deliveryId }],
      timeoutMinutes,
      ...(batchId ? { batchId } : {}),
      ...(record.keep || input.keep ? { keep: true as const } : {}),
    };
    this.receipts.delete(deliveryId);
    this.save(next);
    if (next.state === 'running' && timeoutMinutes !== before) this.arm(next);
    const held = this.held.get(next.id);
    if (held) {
      // 还没投递的下一次执行：追加等它投递后再跟上
      held.appends.push(() => this.sendAppend(next, deliveryId, input, from, seq));
      this.receipt(deliveryId, 'deferred');
    } else void this.sendAppend(next, deliveryId, input, from, seq);
    const warnings = [
      ...((input.context?.length ?? 0) > 8000 ? ['Context truncated to 8000 characters.'] : []),
      ...(input.deadlineMinutes !== undefined && input.deadlineMinutes > limit
        ? [`Deadline capped at ${limit} minutes (the member's delegation limit).`]
        : []),
      ...(input.check ? ['check is ignored for an append; the run keeps its own check.'] : []),
    ];
    return { ...merged, ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
  }

  private async sendAppend(
    record: Delegation,
    deliveryId: string,
    input: DelegateInput,
    from: string,
    seq: number
  ): Promise<void> {
    if (!active(this.deps.store.get(record.id) ?? record)) return;
    const runs = record.taskId ? this.taskRuns(record.taskId) : [];
    const run = runs.findIndex((item) => item.id === record.id) + 1;
    const context = input.context
      ? `\n<context>${escapeXml(input.context.slice(0, 8000))}</context>`
      : '';
    const text = `<delegation-task id="${record.id}" from="${escapeXml(from)}" task="#${seq}" run="${run}" trigger="append">\n${escapeXml(input.task)}${context}\n</delegation-task>`;
    const child = record.childConversationId;
    let sent: BotDeliverResult;
    try {
      sent = await this.deps.host.deliverConversation(child, text, { deliveryId, source: 'bot' });
    } catch (cause) {
      sent = { ok: false, error: String(cause) };
    }
    if (!sent.ok) this.appendFailed(record.id, deliveryId);
    else if (this.deps.host.hasStartedDelivery(child, deliveryId)) {
      if (this.appendOwner(child, deliveryId)) this.accepted.add(deliveryId);
      this.receipt(deliveryId, 'accepted');
    } else if (this.deps.host.deliveryQueued(child, deliveryId))
      this.receipt(deliveryId, 'deferred');
  }

  /** 追加所属的进行中执行（追加还没跑完） */
  private appendOwner(conversationId: string, deliveryId: string): Delegation | undefined {
    return this.deps.store
      .list()
      .find(
        (record) =>
          record.childConversationId === conversationId &&
          active(record) &&
          record.appends?.some((item) => item.deliveryId === deliveryId && item.ok === undefined)
      );
  }

  private receipt(deliveryId: string, state: AppendDelivery): void {
    const known = this.receipts.get(deliveryId);
    if (known === 'accepted' || known === 'failed') return;
    this.receipts.set(deliveryId, state);
    for (const wake of [...(this.receiptWaiters.get(deliveryId) ?? [])]) wake(state);
    this.receiptWaiters.delete(deliveryId);
  }

  /** 追加没送到模型：记失败；原回合已结束且没有别的在等就结算 */
  private appendFailed(recordId: string, deliveryId: string): void {
    this.receipt(deliveryId, 'failed');
    this.accepted.delete(deliveryId);
    const record = this.deps.store.get(recordId);
    if (!record || !active(record)) return;
    if (!record.appends?.some((item) => item.deliveryId === deliveryId && item.ok === undefined))
      return;
    const next = {
      ...record,
      appends: record.appends.map((item) =>
        item.deliveryId === deliveryId ? { ...item, ok: false } : item
      ),
    };
    this.save(next);
    this.settleIfIdle(next.id);
  }

  /**
   * 子会话一个回合（或一条额外投递）结束。回合收尾时还有本执行的追加 / 插话没跑完就先不结算，
   * 记下回合结果，等它们跑完或到期再结算。
   */
  private turnEnded(event: BotTurnFinished): void {
    // 续跑的新记录沿用原子会话，会话绑定的仍是最初的委派 id
    let record = this.deps.store
      .list()
      .find(
        (item) =>
          item.childConversationId === event.conversationId &&
          active(item) &&
          !this.held.has(item.id)
      );
    if (!record || this.settling.has(record.id)) return;
    const outcome: TurnOutcome = {
      ok: event.ok,
      text: event.text,
      ...(event.error ? { error: event.error } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.transient ? { transient: true as const } : {}),
    };
    const id = event.deliveryId;
    if (id && !this.deps.host.hasStartedDelivery(event.conversationId, id)) {
      // 追加 / 插话没送到模型：不是这次执行的回合结果
      if (id === record.id) this.settle(record, outcome);
      else if (record.appends?.some((item) => item.deliveryId === id))
        this.appendFailed(record.id, id);
      else this.settleIfIdle(record.id);
      return;
    }
    const consumed = record.appends?.some(
      (item) => item.ok === undefined && this.accepted.has(item.deliveryId)
    );
    if (consumed && record.appends) {
      record = {
        ...record,
        appends: record.appends.map((item) => {
          if (item.ok !== undefined || !this.accepted.has(item.deliveryId)) return item;
          this.accepted.delete(item.deliveryId);
          return { ...item, ok: event.ok };
        }),
      };
      this.save(record);
    }
    // 登记了卡住：不等排队的追加 / 插话，它们转成下一次执行
    if (this.pending(record) && !record.blocked) this.outcomes.set(record.id, outcome);
    else this.settle(record, outcome);
  }

  private pending(record: Delegation): boolean {
    return (
      !!record.appends?.some((item) => item.ok === undefined) ||
      this.deps.host.hasPendingDeliveries(record.childConversationId)
    );
  }

  private settleIfIdle(recordId: string): void {
    const record = this.deps.store.get(recordId);
    const outcome = this.outcomes.get(recordId);
    if (!record || !active(record) || this.pending(record)) return;
    if (outcome) this.settle(record, outcome);
    else if (record.state === 'queued' && this.rollovers.has(record.id))
      this.finish(record, 'failed', 'error', undefined, 'Queued messages were not delivered.');
  }

  private settle(record: Delegation, outcome: TurnOutcome): void {
    const stored = this.outcomes.get(record.id);
    this.outcomes.delete(record.id);
    // 软停止中止的回合没有正文：用原回合暂存的结果
    if (record.blocked) this.block(record, outcome.text ? outcome : (stored ?? outcome));
    // 第一层这一轮结束时还有它发起的下层没结束：不交回，等下层结果送回、被唤醒的那一轮结束再判定
    else if (
      outcome.ok &&
      unfinishedDownstream(this.deps.store.list(), record.childConversationId).length
    )
      this.wait(record, outcome.text, outcome.turnId);
    else if (outcome.ok && record.check) {
      this.settling.add(record.id);
      void this.verify(record, record.check, outcome.text, outcome.turnId);
    } else
      this.finish(
        record,
        outcome.ok ? 'completed' : 'failed',
        outcome.ok ? undefined : 'error',
        outcome.text,
        outcome.error,
        {
          ...(outcome.turnId ? { turnId: outcome.turnId } : {}),
          ...(outcome.transient ? { transient: true as const } : {}),
        }
      );
  }

  private abort(conversationId: string): Promise<void> {
    const running = this.aborting.get(conversationId);
    if (running) return running;
    const done = this.deps.host
      .abortConversation(conversationId)
      .catch(console.warn)
      .finally(() => this.aborting.delete(conversationId));
    this.aborting.set(conversationId, done);
    return done;
  }

  /** 一次执行结束：排在它之后的下一次执行开始投递（一次只放一个） */
  private releaseHeld(finished: Delegation): void {
    const own = this.held.get(finished.id);
    this.held.delete(finished.id);
    const next = [...this.held]
      .filter(([, item]) => item.after === finished.id)
      .sort(
        ([a], [b]) =>
          (this.deps.store.get(a)?.createdAt ?? 0) - (this.deps.store.get(b)?.createdAt ?? 0)
      );
    if (!next.length) return;
    if (own) {
      for (const [, item] of next) item.after = own.after;
      return;
    }
    const [[id, first], ...rest] = next;
    for (const [, item] of rest) item.after = id;
    this.held.delete(id);
    queueMicrotask(() => {
      void first.run();
    });
  }

  list(chatId?: string): Delegation[] {
    return this.deps.store.list(chatId);
  }

  private newChild(projectId: string, botId: string, delegationId: string) {
    return this.deps.authority.createBotConversation(projectId, {
      botId,
      chatId: null,
      delegationId,
    });
  }

  /** 子会话当前（最新）一次执行；会话绑定的 delegationId 只是第一次 */
  executionOf(childConversationId: string): Delegation | undefined {
    let latest: Delegation | undefined;
    for (const record of this.deps.store.list())
      if (
        record.childConversationId === childConversationId &&
        (!latest || record.createdAt >= latest.createdAt)
      )
        latest = record;
    return latest;
  }

  /** 任务会话可续：未结束、成员与项目一致、最近一次执行属于本任务且已结束（排在它之后时可未结束）、jsonl 还在 */
  private reusable(
    conversationId: string,
    botId: string,
    projectId: string,
    taskId: string,
    queuedAfter = false
  ) {
    const child = this.deps.authority.conversation(conversationId);
    const last = this.executionOf(conversationId);
    const file = child?.sessionFile;
    return (
      !!child &&
      child.lifecycle !== 'ended' &&
      child.projectId === projectId &&
      child.bot?.botId === botId &&
      !!child.bot.delegationId &&
      last?.taskId === taskId &&
      last.depth === 1 &&
      (queuedAfter || !active(last)) &&
      !!file &&
      existsSync(file)
    );
  }

  /** 任务的历次执行（深度 1），按发起先后 */
  private taskRuns(taskId: string): Delegation[] {
    return this.deps.store
      .list()
      .filter((record) => record.taskId === taskId && record.depth === 1)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 续用会话只发增量；新会话发完整任务，任务有历次执行时附 <previous-runs> */
  private sendTask(
    record: Delegation,
    from: string,
    info: TaskInfo = {}
  ): Promise<BotDeliverResult> {
    const acceptance = record.check
      ? `\n<acceptance-check>Passes only if one of your final tool outputs (e.g. a command's output) contains: ${escapeXml(record.check.text)}</acceptance-check>`
      : '';
    const note = record.retryNote
      ? `\n<retry-note>${escapeXml(record.retryNote)}</retry-note>`
      : '';
    const runs = record.taskId ? this.taskRuns(record.taskId) : [];
    const index = runs.findIndex((item) => item.id === record.id);
    let text: string;
    if (info.incremental && info.seq !== undefined && index >= 0) {
      const context = record.context ? `\n<context>${escapeXml(record.context)}</context>` : '';
      text = `<delegation-task id="${record.id}" from="${escapeXml(from)}" task="#${info.seq}" run="${index + 1}" trigger="${record.trigger ?? 'delegate'}">\n${escapeXml(record.task)}${context}${acceptance}${note}\n</delegation-task>`;
    } else {
      const previous = previousRunsText(index >= 0 ? runs.slice(0, index) : [], {
        name: (id) => this.deps.bots.get(id)?.name ?? id,
        ...(info.returnReason ? { returnReason: info.returnReason } : {}),
      });
      text = `<delegation-task id="${record.id}" from="${escapeXml(from)}">\n${escapeXml(record.task)}\n<context>${escapeXml(record.context)}</context>${acceptance}${note}${previous ? `\n${previous}` : ''}\n</delegation-task>`;
    }
    // 附发起时所在群 / 话题的消息作为只读背景（独立块，放在任务之后）：新子会话取最近若干条，
    // 接着同一子会话（任务会话续用）只补上次送过之后的增量
    const group = this.groupContext(
      record,
      record.groupContextSeq ?? this.sessionContextSeq(record)
    );
    const full = `${text}${group?.text ? `\n${group.text}` : ''}`;
    return this.sendWithContext(record.id, record.childConversationId, record.id, group, () =>
      this.deps.host.deliverConversation(record.childConversationId, full, {
        deliveryId: record.id,
        queueIfBusy: true,
        source: 'bot',
      })
    );
  }

  /**
   * 委派子会话的群背景：record.chatId 是委派发起时所在的群或话题（第二层继承同一个群）。
   * cursor 缺省为首次（最近 DELEGATION_CONTEXT_LIMIT 条），给了只取之后的增量。私聊委派、群已不在时返回 undefined。
   */
  private groupContext(
    record: Delegation,
    cursor?: number
  ): { text: string; cursor: number } | undefined {
    const chat = record.chatId ? this.deps.chats.get(record.chatId) : undefined;
    if (chat?.kind !== 'group') return undefined;
    const floor = chat.epochSeq ?? 0;
    let entries: GroupEntry[];
    if (cursor === undefined) {
      // 首次只倒读到够数为止，不读整条时间线
      entries = [];
      let seen = 0;
      for (const entry of this.deps.chats.backward(chat.id, undefined, floor)) {
        entries.push(entry);
        if (
          delegationContextVisible(entry, record.targetBotId) &&
          ++seen >= DELEGATION_CONTEXT_LIMIT
        )
          break;
      }
    } else entries = this.deps.chats.readAfter(chat.id, Math.max(cursor, floor));
    return buildDelegationGroupContext({
      entries,
      botId: record.targetBotId,
      members: this.deps.bots.list(),
      chatTitle: this.deps.chats.rootOf(chat.id)?.title ?? chat.title,
      ...(chat.parentId ? { threadTitle: chat.threadTitle ?? '' } : {}),
      ...(cursor === undefined ? {} : { cursor }),
      floor,
    });
  }

  /** 群背景已送进子会话：记下水位（按最新记录写，不覆盖其间的状态变化；只前进不后退） */
  private injected(id: string, cursor: number): void {
    const latest = this.deps.store.get(id);
    if (latest && (latest.groupContextSeq === undefined || cursor > latest.groupContextSeq))
      this.save({ ...latest, groupContextSeq: cursor });
  }

  /** 同一子会话里之前几次执行已送过的群背景水位（任务会话续用时只补增量）；新子会话返回 undefined */
  private sessionContextSeq(record: Delegation): number | undefined {
    let seq: number | undefined;
    for (const item of this.deps.store.list())
      if (
        item.id !== record.id &&
        item.childConversationId === record.childConversationId &&
        item.groupContextSeq !== undefined &&
        (seq === undefined || item.groupContextSeq > seq)
      )
        seq = item.groupContextSeq;
    return seq;
  }

  private contextKey(conversationId: string, deliveryId: string): string {
    return `${conversationId}\n${deliveryId}`;
  }

  /** 带群背景的那条投递确认开始（已被子会话消费）：推进对应记录的水位 */
  private consumeContext(key: string): void {
    const pending = this.pendingContext.get(key);
    if (!pending) return;
    this.pendingContext.delete(key);
    this.injected(pending.recordId, pending.cursor);
  }

  /**
   * 投递附带群背景：宿主接受（入队 / 已发给 worker）不等于子会话读到了。只有这条投递确认开始
   * （onDeliveryStarted，或返回时 hasStartedDelivery 已成立）才推进水位；发送失败、重复投递、
   * 排队后被取消 / 丢弃、重启时仍在队列里的都不推进，下次往原子会话续跑时照样补上。
   * 没有可见新增（text 为空）时游标只越过不收的条目，不会漏消息，送出即推进。
   */
  private async sendWithContext<T extends BotDeliverResult | BotSendResult>(
    recordId: string,
    conversationId: string,
    deliveryId: string,
    group: { text: string; cursor: number } | undefined,
    send: () => Promise<T>
  ): Promise<T> {
    if (!group) return send();
    if (!group.text) {
      const sent = await send();
      if (sent.ok) this.injected(recordId, group.cursor);
      return sent;
    }
    const key = this.contextKey(conversationId, deliveryId);
    const pending = { recordId, cursor: group.cursor };
    // 先登记再发送：开始事件可能在 send 返回前就到达
    this.pendingContext.set(key, pending);
    let sent: T;
    try {
      sent = await send();
    } catch (cause) {
      if (this.pendingContext.get(key) === pending) this.pendingContext.delete(key);
      throw cause;
    }
    // 已被开始事件消费，或被同一投递的后一次尝试接替
    if (this.pendingContext.get(key) !== pending) return sent;
    if (!sent.ok || sent.duplicate) this.pendingContext.delete(key);
    else if (this.deps.host.hasStartedDelivery(conversationId, deliveryId))
      this.consumeContext(key);
    return sent;
  }

  /** 记录进入终态：它名下还没确认消费的群背景不再等（排队的投递已随取消丢弃） */
  private dropPendingContext(recordId: string): void {
    for (const [key, pending] of this.pendingContext)
      if (pending.recordId === recordId) this.pendingContext.delete(key);
  }

  /**
   * 沿用原子会话：中途失败从最后一步续跑，验收没过补一条原因；会话恢复不了才换新子会话从头发任务。
   * 带说明 / 验收原因 / 群背景新增的续跑是一条新消息，按 resume 投递：worker 先像断点重试那样
   * 把未完成的最后一条 assistant 移出模型上下文，再带着新消息继续；什么都不补时照常断点重跑。
   */
  private async resume(
    record: Delegation,
    resume: Resume,
    freshChild: () => string | undefined,
    from: string,
    info: TaskInfo
  ): Promise<BotDeliverResult> {
    const note = resume.note ? `\nNote from ${escapeXml(from)}: ${escapeXml(resume.note)}` : '';
    const options = {
      deliveryId: record.id,
      queueIfBusy: true,
      source: 'bot' as const,
      resume: true as const,
    };
    // 原子会话已有之前给过的背景：只补其后的新增；没有新增就照常续跑，不发空块
    const group = this.groupContext(record, resume.groupContextSeq);
    const extra = group?.text ? `\n${group.text}` : '';
    const text =
      resume.checkFailed && record.check
        ? `<delegation-check-failed id="${record.id}">\nThe acceptance check failed: none of your final tool outputs contained: ${escapeXml(record.check.text)}\nFix the work and finish again; this delegation passes only if one of your final tool outputs contains it.${note}\n</delegation-check-failed>${extra}`
        : resume.note || extra
          ? `<delegation-retry id="${record.id}">\nYour previous attempt at this delegated task did not finish. Continue from where you stopped.${note}\n</delegation-retry>${extra}`
          : undefined;
    const sent = await this.sendWithContext(
      record.id,
      resume.conversationId,
      record.id,
      group,
      text === undefined
        ? () => this.deps.host.retryConversation(resume.conversationId, { delegation: true })
        : () => this.deps.host.deliverConversation(resume.conversationId, text, options)
    );
    // 没送出去：水位保持原子会话已收到的（创建记录时已沿用），下次续跑再补
    if (sent.ok || RESUME_TRANSIENT.has(sent.error)) return sent;
    const current = this.deps.store.get(record.id);
    if (!current || !active(current)) return sent;
    const conversationId = freshChild();
    if (!conversationId) return { ok: false, error: 'Delegation workspace unavailable.' };
    // 新子会话什么都没收到过：从头给任务和最近的群背景
    const { groupContextSeq: _seq, ...rest } = current;
    const fresh = { ...rest, childConversationId: conversationId };
    this.save(fresh);
    return this.sendTask(fresh, from, { ...info, incremental: false });
  }

  check(parentConversationId: string, input: { id?: string; cancel?: boolean }): unknown {
    const records = this.list().filter(
      (record) =>
        record.parentConversationId === parentConversationId &&
        (!input.id || record.id === input.id)
    );
    if (input.id && !records.length)
      return { ok: false, error: 'Delegation not found in this parent session.' };
    if (input.cancel) {
      if (!input.id) return { ok: false, error: 'Specify id to cancel a delegation.' };
      return this.cancel(input.id);
    }
    return { ok: true, delegations: records };
  }

  /** 委派所属聊天（共享浏览器等按聊天归属的资源用） */
  chatIdOf(id: string): string | null {
    return this.deps.store.get(id)?.chatId ?? null;
  }

  /** 委派发起成员 */
  parentBotOf(id: string): string | undefined {
    return this.deps.store.get(id)?.parentBotId;
  }

  cancel(id: string): { ok: boolean; error?: string } {
    const record = this.deps.store.get(id);
    if (!record) return { ok: false, error: 'Delegation not found.' };
    if (!active(record)) {
      // 等待自动重试的视同进行中：取消即放弃自动重试，最终失败照常交回委派人
      if (pendingAutoRetry(record, this.deps.store.list())) this.abandonAutoRetry(record.id);
      return { ok: true };
    }
    const held = this.held.has(id);
    this.finish(record, 'canceled');
    // 排着的下一次执行还没投递：子会话属于正在跑的那次，不能停
    if (!held) void this.abort(record.childConversationId);
    return { ok: true };
  }

  /** 默认从断点续跑；手动取消的须由用户选 resume / restart，子会话丢失或文件不在才从头 */
  retry(
    id: string,
    mode?: DelegationRetryMode,
    options: { by?: DelegationRetryBy; note?: string } = {}
  ): DelegateResult {
    const by = options.by ?? 'human';
    const record = this.deps.store.get(id);
    if (!record || (record.state !== 'failed' && record.state !== 'canceled'))
      return {
        ok: false,
        error: 'Only failed, canceled or interrupted delegations can be retried.',
      };
    if (record.state === 'canceled' && !mode)
      return { ok: false, error: 'Choose to resume or restart a canceled delegation.' };
    if (this.deps.store.list().some((item) => item.retryOf === id))
      return { ok: false, error: 'This delegation has already been retried.' };
    // 任务仍空闲（已退回待办）时沿用关联；已完成 / 取消 / 被别人接手则不再绑定
    const taskId =
      record.taskId &&
      this.deps.tasks?.gate(record.chatId, record.taskId, record.parentBotId, record.targetBotId).ok
        ? record.taskId
        : undefined;
    const child = this.deps.authority.conversation(record.childConversationId);
    const file = child && child.lifecycle !== 'ended' ? child.sessionFile : undefined;
    const resume =
      mode !== 'restart' && file && existsSync(file)
        ? {
            conversationId: record.childConversationId,
            checkFailed: record.failure === 'check',
            ...(options.note ? { note: options.note } : {}),
            ...(record.groupContextSeq !== undefined
              ? { groupContextSeq: record.groupContextSeq }
              : {}),
          }
        : undefined;
    // 自动重试沿用原批次；等待自动重试时人工点重试也接替进原批次（不先把失败交回委派人）；
    // 委派人重试并入其当前轮次；其余界面重试是用户在轮次之外的操作，自成一批，
    // 群里开过新对话就从委派人的新会话发起
    const takeOver =
      by === 'auto' || (by === 'human' && pendingAutoRetry(record, this.deps.store.list()));
    const note = options.note ?? (by === 'auto' ? record.retryNote : undefined);
    const sent = this.delegate(
      by === 'human' && !takeOver
        ? (this.delegatorSession(record) ?? record.parentConversationId)
        : record.parentConversationId,
      {
        to: record.targetBotId,
        task: record.task,
        context: record.context,
        ...(taskId ? { taskId } : {}),
        ...(record.timeoutMinutes ? { deadlineMinutes: record.timeoutMinutes } : {}),
        ...(record.check ? { check: { kind: record.check.kind, text: record.check.text } } : {}),
        // 重试延续原任务的停止策略：keep 的不随父回合停止而取消
        ...(record.keep ? { keep: true } : {}),
      },
      {
        standalone: by === 'human',
        ...(takeOver ? { batchId: record.batchId ?? record.id } : {}),
        retryOf: id,
        retryBy: by,
        ...(note ? { retryNote: note } : {}),
        ...(resume ? { resume } : {}),
        ...(mode === 'restart' ? { fresh: true } : {}),
      }
    );
    // 接替成功才撤掉原来排定的自动重试；接替失败时原记录仍按时自动重试
    if (sent.ok && takeOver) {
      clearTimeout(this.retryTimers.get(id));
      this.retryTimers.delete(id);
    }
    return sent;
  }

  /**
   * retry_delegation：委派人在自己的会话里重试一条失败 / 取消的委派（相当于 Grok 的 Task resume）。
   * 只认本会话发起的委派；同一条链最多 DELEGATOR_RETRY_LIMIT 次（界面重试不计入、不受限）。
   */
  retryAsDelegator(parentConversationId: string, id: string, note?: string): DelegatorRetryResult {
    const record = this.deps.store.get(id);
    if (!record || record.parentConversationId !== parentConversationId)
      return { ok: false, error: 'Delegation not found in this parent session.' };
    const used = delegatorRetries(record, (key) => this.deps.store.get(key));
    if (used >= DELEGATOR_RETRY_LIMIT)
      return {
        ok: false,
        error: `Retry limit reached: you have already retried this delegation chain ${DELEGATOR_RETRY_LIMIT} times. Delegate it to another member, skip it, or end it explicitly.`,
      };
    if (pendingAutoRetry(record, this.deps.store.list()))
      return { ok: false, error: 'An automatic retry is already scheduled for this delegation.' };
    const trimmed = note?.trim().slice(0, DELEGATION_NOTE_MAX);
    const result = this.retry(id, record.state === 'canceled' ? 'resume' : undefined, {
      by: 'delegator',
      ...(trimmed ? { note: trimmed } : {}),
    });
    return result.ok ? { ...result, retriesLeft: DELEGATOR_RETRY_LIMIT - used - 1 } : result;
  }

  /** 失败后是否、隔多久自动重试；不满足条件返回 undefined（直接交回委派人） */
  private autoRetryDelay(record: Delegation): number | undefined {
    const kind = autoRetryKind(record);
    if (!kind || this.disposed) return undefined;
    // 有没跑完的追加：重试只带原任务，会丢掉这些追加；交回委派人，由它看结果里的清单决定
    if (record.appends?.some((item) => item.ok === false)) return undefined;
    const attempt = trailingAutoRetries(record, (key) => this.deps.store.get(key)) + 1;
    if (attempt > AUTO_RETRY_MAX) return undefined;
    const parent = this.deps.authority.conversation(record.parentConversationId);
    const target = this.deps.bots.get(record.targetBotId);
    const chat = record.chatId ? this.deps.chats.get(record.chatId) : undefined;
    if (
      !parent ||
      parent.lifecycle === 'ended' ||
      !target ||
      target.archivedAt !== undefined ||
      (record.chatId && (!chat || chat.archivedAt !== undefined))
    )
      return undefined;
    return Math.max(0, (this.deps.autoRetryDelayMs ?? defaultAutoRetryDelayMs)(kind, attempt));
  }

  private scheduleAutoRetry(record: Delegation): void {
    if (this.disposed || record.autoRetryAt === undefined) return;
    clearTimeout(this.retryTimers.get(record.id));
    const timer = setTimeout(
      () => this.runAutoRetry(record.id),
      Math.max(0, record.autoRetryAt - Date.now())
    );
    timer.unref?.();
    this.retryTimers.set(record.id, timer);
  }

  /** 到点：在原子会话上续跑（会话恢复不了才从头）；发不出去就放弃，最终失败交回委派人 */
  private runAutoRetry(id: string): void {
    this.retryTimers.delete(id);
    if (this.disposed) return;
    const current = this.deps.store.get(id);
    if (!current || !pendingAutoRetry(current, this.deps.store.list())) return;
    const result = this.retry(id, undefined, { by: 'auto' });
    if (!result.ok) {
      console.warn('[bots] delegation auto-retry failed', result.error);
      this.abandonAutoRetry(id);
    }
  }

  /** 放弃排定的自动重试：清掉 autoRetryAt，该记录随即按最终失败处理 */
  private abandonAutoRetry(id: string): void {
    clearTimeout(this.retryTimers.get(id));
    this.retryTimers.delete(id);
    const latest = this.deps.store.get(id);
    if (!latest || latest.autoRetryAt === undefined) return;
    const { autoRetryAt: _at, ...rest } = latest;
    this.save(rest);
    queueMicrotask(() => {
      void this.deliverPending(latest.parentConversationId);
    });
  }

  /**
   * 退回返工：原执行人在本任务会话里新开一次执行（trigger rework，不挂 retryOf）。
   * 成员验收时结果回到它当前群会话；人验收时回到委派人的会话，群里开过新对话就回到新会话。
   */
  rework(input: {
    chatId: string;
    delegationId: string;
    actor: string;
    reason: string;
  }): DelegateResult {
    const last = this.deps.store.get(input.delegationId);
    if (!last?.taskId) return { ok: false, error: 'Delegation not found.' };
    const human = input.actor === 'human';
    const parentConversationId = human
      ? this.delegatorSession(last)
      : this.deps.chats.get(input.chatId)?.sessions[input.actor]?.conversationId;
    if (!parentConversationId) return { ok: false, error: 'Parent bot session unavailable.' };
    const by = human
      ? 'a human reviewer'
      : (this.deps.bots.get(input.actor)?.name ?? 'the reviewer');
    return this.delegate(
      parentConversationId,
      {
        to: last.targetBotId,
        taskId: last.taskId,
        task: `Your delivery was returned for rework by ${by}. Reason:\n${input.reason}`,
        ...(last.timeoutMinutes ? { deadlineMinutes: last.timeoutMinutes } : {}),
      },
      { standalone: human, trigger: 'rework' }
    );
  }

  /** 委派人的会话：原会话还在用原会话，群聊里原会话已结束（新对话）就用它在该群的当前会话 */
  private delegatorSession(record: Delegation): string | undefined {
    const parent = this.deps.authority.conversation(record.parentConversationId);
    if (parent && parent.lifecycle !== 'ended') return parent.conversationId;
    if (
      !record.chatId ||
      record.depth !== 1 ||
      this.deps.chats.get(record.chatId)?.kind !== 'group'
    )
      return undefined;
    const session = this.deps.host.ensureSession(record.chatId, record.parentBotId);
    return session.ok ? session.conversationId : undefined;
  }

  /** 子会话正在跑的那次执行（排在后面、还没投递的不算） */
  private runningIn(childConversationId: string): Delegation | undefined {
    return this.deps.store
      .list()
      .find(
        (record) =>
          record.childConversationId === childConversationId &&
          record.state === 'running' &&
          !this.held.has(record.id)
      );
  }

  /** report_blocked：只登记，本轮由模型自然结束后记为 blocked；5 分钟还没收尾就软停止 */
  reportBlocked(
    childConversationId: string,
    input: { need: string; waitFor?: 'human' | 'parent' }
  ): { ok: true; instruction: string } | { ok: false; error: string } {
    const record = this.deps.authority.conversation(childConversationId)?.bot?.delegationId
      ? this.runningIn(childConversationId)
      : undefined;
    if (!record?.taskId || record.depth !== 1)
      return {
        ok: false,
        error: 'report_blocked is only available while working on a delegated board task.',
      };
    const need = input.need.trim().slice(0, DELEGATION_BLOCKED_NEED_MAX);
    if (!need) return { ok: false, error: 'Describe what you need in need.' };
    this.save({
      ...record,
      blocked: { need, waitFor: input.waitFor ?? 'parent', at: Date.now() },
    });
    clearTimeout(this.blockTimers.get(record.id));
    const timer = setTimeout(
      () => this.softStop(record.id),
      DELEGATION_BLOCKED_STOP_MINUTES * (this.deps.minuteMs ?? 60_000)
    );
    timer.unref?.();
    this.blockTimers.set(record.id, timer);
    return {
      ok: true,
      instruction:
        'Blocked reported. In one or two sentences say what you have done so far, then end your turn now; do not keep working on this task. You will continue in this session once someone answers.',
    };
  }

  /** 登记卡住后迟迟不收尾：只中止当前回合（不取消排队、不级联取消子委派） */
  private softStop(id: string): void {
    this.blockTimers.delete(id);
    const record = this.deps.store.get(id);
    if (!record || !active(record) || !record.blocked || this.settling.has(id)) return;
    // 先中止正在跑的回合（回合结束事件里按卡住结算）；没有在跑的回合才直接结算
    void this.deps.host
      .interruptTurn(record.childConversationId, BOT_BLOCKED_STOP)
      .catch(console.warn)
      .then((stopped) => {
        const latest = this.deps.store.get(id);
        if (!stopped && latest && active(latest))
          this.block(latest, this.outcomes.get(id) ?? { ok: false, text: '' });
      });
  }

  /**
   * 执行记为 blocked（释放名额、停计时、结果照常回传）。子会话里还排着的追加 / 插话
   * 不撤掉，转成同一会话的下一次执行（来源追加），排在后面的执行改排到它之后。
   */
  private block(record: Delegation, outcome: TurnOutcome): void {
    const open = record.appends?.filter((item) => item.ok === undefined) ?? [];
    const kept = record.appends?.filter((item) => item.ok !== undefined) ?? [];
    const { appends: _appends, ...base } = record;
    const next: Delegation | undefined =
      open.length || this.deps.host.hasPendingDeliveries(record.childConversationId)
        ? {
            id: randomUUID(),
            parentConversationId: record.parentConversationId,
            parentBotId: record.parentBotId,
            targetBotId: record.targetBotId,
            chatId: record.chatId,
            task: open.length
              ? open.map((item) => item.text).join('\n\n')
              : 'Messages queued while the previous run was ending.',
            context: '',
            childConversationId: record.childConversationId,
            state: 'queued',
            depth: record.depth,
            createdAt: Date.now(),
            ...(record.effectivePermissions
              ? { effectivePermissions: record.effectivePermissions }
              : {}),
            ...(record.taskId ? { taskId: record.taskId } : {}),
            ...(record.keep ? { keep: true as const } : {}),
            ...(record.check
              ? { check: { kind: record.check.kind, text: record.check.text } }
              : {}),
            ...(record.timeoutMinutes ? { timeoutMinutes: record.timeoutMinutes } : {}),
            trigger: 'append',
            ...(open.length ? { appends: open } : {}),
          }
        : undefined;
    if (next)
      for (const entry of this.held.values()) if (entry.after === record.id) entry.after = next.id;
    this.finish(
      kept.length ? { ...base, appends: kept } : base,
      'blocked',
      undefined,
      outcome.text || undefined
    );
    if (next) {
      this.rollovers.add(next.id);
      this.save(next);
    }
  }

  /** 人在任务卡回复缺信息卡住的任务：同成员同会话新开一次执行，结果回委派人（原会话失效则其当前会话） */
  reply(input: { chatId: string; delegationId: string; text: string }): DelegateResult {
    const last = this.deps.store.get(input.delegationId);
    if (!last?.taskId || last.state !== 'blocked')
      return { ok: false, error: 'This task is not waiting for an answer.' };
    const parentConversationId = this.delegatorSession(last);
    if (!parentConversationId) return { ok: false, error: 'Parent bot session unavailable.' };
    return this.delegate(
      parentConversationId,
      {
        to: last.targetBotId,
        taskId: last.taskId,
        task: `A human answered on the task card:\n${input.text}`,
        ...(last.timeoutMinutes ? { deadlineMinutes: last.timeoutMinutes } : {}),
      },
      { standalone: true, trigger: 'reply', human: true }
    );
  }

  /** 人在任务卡回复执行中的任务：作为真人插话投进当前执行的子会话 */
  async interject(input: {
    delegationId: string;
    text: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const record = this.deps.store.get(input.delegationId);
    if (!record || !active(record) || this.held.has(record.id))
      return { ok: false, error: 'This run has ended.' };
    const sent = await this.deps.host.deliverConversation(
      record.childConversationId,
      `From a human on the task card:\n${input.text}`,
      { source: 'human', deliveryId: randomUUID() }
    );
    return sent.ok ? { ok: true } : { ok: false, error: sent.error };
  }

  /** 父回合被停止：取消该轮发起且未 keep 的委派；整批都已结束则只落时间线，不再唤醒父会话 */
  private stopBatch(parentConversationId: string, batchId: string): void {
    const batch = () =>
      this.deps.store
        .list()
        .filter(
          (record) =>
            record.parentConversationId === parentConversationId && record.batchId === batchId
        );
    this.discarding = true;
    try {
      const all = this.deps.store.list();
      for (const record of batch())
        if ((active(record) || pendingAutoRetry(record, all)) && !record.keep)
          this.cancel(record.id);
    } finally {
      this.discarding = false;
    }
    const rest = batch();
    const all = this.deps.store.list();
    if (rest.length && !rest.some((record) => active(record) || pendingAutoRetry(record, all)))
      this.delivered(rest);
  }

  /** 群开新对话：未 keep 的取消，已结束未投递的只落时间线；keep 的跑完后父会话已结束，同样只落时间线 */
  startOver(chatId: string): void {
    const records = () => this.deps.store.list().filter((record) => record.chatId === chatId);
    this.discarding = true;
    try {
      const all = this.deps.store.list();
      for (const record of records())
        if ((active(record) || pendingAutoRetry(record, all)) && !record.keep)
          this.cancel(record.id);
    } finally {
      this.discarding = false;
    }
    const all = this.deps.store.list();
    const done = records().filter(
      (record) =>
        !active(record) && !pendingAutoRetry(record, all) && record.deliveredAt === undefined
    );
    if (done.length) this.delivered(done);
  }

  /** 私聊回退越过发起委派的回合：取消进行中的，未投递结果一律作废（规则见 rewoundDelegations） */
  discardRewound(parentConversationId: string, since: number): void {
    const { cancel, discard } = rewoundDelegations(this.list(), parentConversationId, since);
    this.discarding = true;
    try {
      for (const id of cancel) this.cancel(id);
    } finally {
      this.discarding = false;
    }
    const records = discard.flatMap((id) => this.deps.store.get(id) ?? []);
    if (records.length) this.delivered(records);
  }

  observeRunning(conversationId: string): void {
    const record = this.list().find(
      (item) =>
        item.childConversationId === conversationId &&
        item.state === 'queued' &&
        !this.held.has(item.id)
    );
    if (record) this.started(record);
  }

  /** queued → running 的唯一入口：期限从真正开工起算 */
  private started(record: Delegation): void {
    if (record.state !== 'queued' || this.disposed) return;
    const running: Delegation = { ...record, state: 'running', startedAt: Date.now() };
    this.save(running);
    this.arm(running);
  }

  /** 到期时刻 = startedAt + timeoutMinutes（追加会把它往后推） */
  private arm(record: Delegation): void {
    if (this.disposed) return;
    clearTimeout(this.timers.get(record.id));
    const at =
      (record.startedAt ?? Date.now()) +
      (record.timeoutMinutes ?? DELEGATION_TIMEOUT_MINUTES) * (this.deps.minuteMs ?? 60_000);
    const timer = setTimeout(() => this.expire(record.id), Math.max(0, at - Date.now()));
    timer.unref?.();
    this.timers.set(record.id, timer);
  }

  /** 到期强制结算：原回合已结束只在等追加的，按回合结果结算，没跑完的追加记失败 */
  private expire(id: string): void {
    const current = this.deps.store.get(id);
    if (!current || !active(current) || this.settling.has(id)) return;
    if (current.blocked) {
      this.softStop(id);
      return;
    }
    const outcome = this.outcomes.get(id);
    if (outcome) this.settle(current, outcome);
    else this.finish(current, 'failed', 'timeout');
    void this.abort(current.childConversationId);
  }

  /** 第一层这一轮已结束、下层还没结束：保持 running，记下这一轮的输出 */
  private wait(record: Delegation, text: string, turnId?: string): void {
    this.save({
      ...record,
      waiting: { since: Date.now(), text, ...(turnId ? { turnId } : {}) },
    });
  }

  /**
   * 第一层已有最终结果（完成 / 最终失败 / 取消 / 超时，且不在等自动重试）：它发起的下层没人整合了。
   * 未 keep 的级联取消；已结束的整批只落记录（群里出卡片），不再唤醒第一层的子会话。
   * 反过来，等待中的第一层若已没有可等的下层，以暂存的那一轮输出判定。能走到这里说明下层全是被外部作废的
   * （群开新对话 / 回退 / 停止等，结果不会再送回）：凡是结果真正送进子会话的，integrating 都已先清掉 waiting。
   */
  private settleNested(): void {
    const all = this.deps.store.list();
    const owners = new Map<string, Delegation>();
    for (const record of all) {
      const owner = owners.get(record.childConversationId);
      if (!owner || record.createdAt >= owner.createdAt)
        owners.set(record.childConversationId, record);
    }
    const orphaned = (conversationId: string) => {
      const owner = owners.get(conversationId);
      return Boolean(owner && !active(owner) && !pendingAutoRetry(owner, all));
    };
    const records = all.filter((record) => orphaned(record.parentConversationId));
    this.discarding = true;
    try {
      for (const record of records)
        if (!record.keep && (active(record) || pendingAutoRetry(record, all)))
          this.cancel(record.id);
    } finally {
      this.discarding = false;
    }
    const latest = this.deps.store.list();
    for (const batch of delegationBatches(
      latest.filter((record) => orphaned(record.parentConversationId))
    ))
      if (
        !batch.some((record) => active(record) || pendingAutoRetry(record, latest)) &&
        batch.some((record) => record.deliveredAt === undefined)
      )
        this.delivered(batch);
    for (const stale of owners.values()) {
      // 上面的级联取消可能已改过这条记录：按最新状态判定，避免用旧快照把已结束的记录写回进行中
      const owner = this.deps.store.get(stale.id);
      if (
        owner?.waiting &&
        active(owner) &&
        !this.deps.host.isBusy(owner.childConversationId) &&
        !unfinishedDownstream(latest, owner.childConversationId).length
      )
        this.settleWaiting(owner);
    }
  }

  /** 等待结束且没有新的一轮：按暂存的那一轮输出走正常完成流程（有验收的照常验收） */
  private settleWaiting(record: Delegation): void {
    const { waiting, ...rest } = record;
    if (!waiting) return;
    // 先清掉等待标记再判定：验收是异步的，避免重复进入
    this.save(rest);
    if (rest.check) void this.verify(rest, rest.check, waiting.text, waiting.turnId);
    else
      this.finish(rest, 'completed', undefined, waiting.text, undefined, {
        ...(waiting.turnId ? { turnId: waiting.turnId } : {}),
      });
  }

  /**
   * 下层结果已确认送进第一层子会话：第一层不再处于等待，暂存文本作废。
   * 整合轮正在跑：交给它结束时判定。没在跑（结果已写进 jsonl、Main 未确认开始就崩溃，重启后 worker 里已没有这一轮）：
   * 与「第一层在跑一轮时重启」一致，标 interrupted 并按自动重试规则从断点续跑整合轮（结果已在会话里，不重送）。
   * 必须在给下层记 deliveredAt 之前调用：反过来中间崩溃，重启后会被当成下层已作废而交回暂存文本。
   */
  private integrating(conversationId: string): void {
    const owner = delegationOwner(this.deps.store.list(), conversationId);
    if (!owner?.waiting || !active(owner)) return;
    if (this.deps.host.isBusy(conversationId)) {
      const { waiting: _waiting, ...rest } = owner;
      this.save(rest);
    } else this.finish(owner, 'failed', 'interrupted');
  }

  async deliverPending(parentConversationId?: string): Promise<void> {
    if (this.disposed) return;
    this.settleNested();
    const keys = delegationBatches(this.list()).map((batch) => batchKey(batch[0]));
    for (const key of keys) {
      // 前面批次的 integrating / delivered、以及投递时的 await 都会改记录：每批都按最新记录判定，不沿用开头的快照
      const all = this.list();
      const batch = delegationBatches(all.filter((record) => batchKey(record) === key))[0];
      if (!batch) continue;
      const head = batch[0];
      const deliveryId = batchDeliveryId(batch);
      if (
        batch.some(active) ||
        // 等待自动重试：视同未结束，不唤醒委派人
        batch.some((record) => pendingAutoRetry(record, all)) ||
        batch.every((record) => record.deliveredAt !== undefined) ||
        this.delivering.has(deliveryId) ||
        (parentConversationId && head.parentConversationId !== parentConversationId) ||
        this.deps.host.isBusy(head.parentConversationId)
      )
        continue;
      const parent = this.deps.authority.conversation(head.parentConversationId);
      if (!parent || parent.lifecycle === 'ended') {
        if (head.chatId && this.deps.chats.get(head.chatId)?.kind === 'group')
          this.delivered(batch);
        continue;
      }
      if (this.deps.host.hasStartedDelivery(head.parentConversationId, deliveryId)) {
        // 结果已在子会话里但 Main 没确认开始（崩溃窗口）：先落第一层的状态，再给下层记 deliveredAt
        this.integrating(head.parentConversationId);
        this.delivered(batch);
        continue;
      }
      if (parent.bot?.delegationId) {
        // 只往仍在进行（含等待下层）的第一层子会话送：卡住在等答复、已结束或等自动重试的先不送，
        // 免得在这些会话里起一轮无主回合；等续跑那一轮结束再送
        const owner = delegationOwner(all, parent.conversationId);
        if (!owner || !active(owner)) continue;
        const bot = this.deps.bots.get(owner.targetBotId);
        const saved = owner.effectivePermissions;
        // 重启后宿主不再有子会话的注册：按委派时的权限快照重新注册（缺快照的旧数据按只读）
        if (
          !bot ||
          !this.deps.host.registerDelegation(
            parent.conversationId,
            saved
              ? { ...bot, ...saved }
              : { ...bot, tools: 'readonly', approvalMode: 'supervised' },
            {
              parentConversationId: owner.parentConversationId,
              chatId: owner.chatId,
              ...(owner.taskId && owner.depth === 1 ? { task: true as const } : {}),
            }
          )
        )
          continue;
      }
      // 唤醒第一层：结果之后补上它上次收到背景以来群里的新增（没有新增不附）
      const owner = parent.bot?.delegationId
        ? delegationOwner(all, parent.conversationId)
        : undefined;
      const group = owner ? this.groupContext(owner, owner.groupContextSeq) : undefined;
      this.delivering.add(deliveryId);
      try {
        const results = batchResultText(batch, (id) => this.deps.bots.get(id)?.name ?? id, {
          inGroup: Boolean(head.chatId && this.deps.chats.get(head.chatId)?.kind === 'group'),
          retriesLeft: (record) =>
            Math.max(
              0,
              DELEGATOR_RETRY_LIMIT - delegatorRetries(record, (key) => this.deps.store.get(key))
            ),
        });
        // 结果必须在最前：是否已投递靠开头的 <delegation-result id> 判断
        const text = group?.text ? `${results}\n${group.text}` : results;
        const send = (): Promise<BotDeliverResult | BotSendResult> =>
          parent.bot?.chatId &&
          this.deps.chats.get(parent.bot.chatId)?.kind === 'group' &&
          this.deps.deliverGroupResult
            ? this.deps.deliverGroupResult(head, text, deliveryId, batch)
            : this.deps.host.deliverConversation(head.parentConversationId, text, {
                onlyIfIdle: true,
                source: 'bot',
                deliveryId,
              });
        // 水位在确认消费时推进（sendWithContext 返回前或开始事件里），先于下面落第一层状态：
        // integrating 可能标中断并排续跑，续跑记录要继承新水位
        const sent = owner
          ? await this.sendWithContext(owner.id, head.parentConversationId, deliveryId, group, send)
          : await send();
        if (sent.ok && this.deps.host.hasStartedDelivery(head.parentConversationId, deliveryId)) {
          this.integrating(head.parentConversationId);
          this.delivered(batch);
        }
      } catch (cause) {
        console.warn('[bots] delegation delivery failed', cause);
      } finally {
        this.delivering.delete(deliveryId);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribeDiscard();
    this.unsubscribeStarted();
    this.unsubscribeDeferred();
    for (const waiters of this.receiptWaiters.values())
      for (const wake of [...waiters]) wake('deferred');
    this.receiptWaiters.clear();
    for (const timer of [...this.timers.values(), ...this.blockTimers.values()])
      clearTimeout(timer);
    this.timers.clear();
    this.blockTimers.clear();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.pendingContext.clear();
  }

  disable(): void {
    this.disposed = true;
    for (const record of this.deps.store.list()) if (active(record)) this.cancel(record.id);
    this.dispose();
  }

  private finish(
    record: Delegation,
    state: Delegation['state'],
    failure?: Delegation['failure'],
    result?: string,
    error?: string,
    extra: { turnId?: string; transient?: true } = {}
  ): void {
    clearTimeout(this.timers.get(record.id));
    this.timers.delete(record.id);
    clearTimeout(this.blockTimers.get(record.id));
    this.blockTimers.delete(record.id);
    const held = this.held.has(record.id);
    const orphaned =
      !held &&
      state !== 'blocked' &&
      (record.appends?.some((item) => item.ok === undefined) ||
        this.deps.host.hasPendingDeliveries(record.childConversationId));
    this.dropPendingContext(record.id);
    const { waiting: _waiting, ...base } = record;
    let finished: Delegation = {
      ...base,
      ...closeAppends(record),
      state,
      finishedAt: Date.now(),
      ...(failure ? { failure } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
      ...(state === 'failed' && failure === 'error' && extra.transient
        ? { transient: true as const }
        : {}),
    };
    const delay = this.autoRetryDelay(finished);
    if (delay !== undefined) finished = { ...finished, autoRetryAt: Date.now() + delay };
    // 待入群标记与终态同一行落盘：之后任一步崩溃，重启都能据此补写
    if (!this.disposed && this.resultChatId(finished))
      finished = {
        ...finished,
        pendingResultEntry: extra.turnId ? { turnId: extra.turnId } : {},
      };
    this.save(finished);
    this.outcomes.delete(record.id);
    this.settling.delete(record.id);
    this.rollovers.delete(record.id);
    for (const item of record.appends ?? []) {
      if (item.ok === undefined) this.receipt(item.deliveryId, 'failed');
      this.accepted.delete(item.deliveryId);
      this.receipts.delete(item.deliveryId);
    }
    // 结束时子会话里还排着本次执行的追加 / 插话：一并撤掉，不留成无主回合
    if (orphaned) void this.abort(record.childConversationId);
    this.releaseHeld(finished);
    if (finished.pendingResultEntry) this.postResult(finished);
    // 排定了自动重试的不算结束：不发「谁结束了」提示，等接替记录有结果
    if (finished.autoRetryAt !== undefined) this.scheduleAutoRetry(finished);
    else this.noticeWaiting(finished);
    queueMicrotask(() => {
      void this.deliverPending(record.parentConversationId);
    });
  }

  /** 委派开始后子会话的最终工具结果里找验收文本；读失败按未通过 */
  private async verify(
    record: Delegation,
    check: TaskCheck,
    text: string,
    turnId?: string
  ): Promise<void> {
    let passed = false;
    try {
      const messages = await this.deps.sessionMessages?.(record.childConversationId);
      passed = messages ? checkPassed(check, messages, this.startedAt(record)) : false;
    } catch (cause) {
      console.warn('[bots] delegation check read failed', cause);
    }
    const current = this.deps.store.get(record.id);
    if (this.disposed || !current || !active(current)) {
      this.settling.delete(record.id);
      return;
    }
    const checked = { ...current, check: { ...check, passed } };
    if (passed) this.finish(checked, 'completed', undefined, text, undefined, { turnId });
    else this.finish(checked, 'failed', 'check', text, checkFailureText(check));
  }

  /**
   * 结果该写进的群：第一层委派（发起方就是该成员当前的群会话）completed、群 / 话题仍在且未归档。
   * 第二层的结果由第一层成员整合进自己的结果，不入群。
   */
  private resultChatId(record: Delegation): string | undefined {
    if (
      record.state !== 'completed' ||
      !record.chatId ||
      !record.result?.trim() ||
      isSkipReply(record.result)
    )
      return undefined;
    const chat = this.deps.chats.get(record.chatId);
    if (chat?.kind !== 'group' || chat.archivedAt !== undefined) return undefined;
    if (chat.sessions[record.parentBotId]?.conversationId !== record.parentConversationId)
      return undefined;
    return record.chatId;
  }

  /**
   * 处理待入群标记：结果以被委派成员名义写进群时间线，记下 resultSeq 并清掉标记。
   * 条目 id 固定、先查后写保证幂等（已写过只回填 resultSeq）；它直接落时间线、不经 GroupChatService，
   * 不触发 @ 接力或讨论判断，也不唤醒发起人。发起人已随回传收到全文的（重启补写才会出现），条目标 hiddenFrom。
   * 群 / 话题已删除、已归档或发起方会话已换：不写，只清标记；写时抛错则保留标记，下次启动再补。
   */
  private postResult(record: Delegation): void {
    if (this.disposed || !record.pendingResultEntry) return;
    const id = `delegation-result:${record.id}`;
    let seq: number | undefined;
    try {
      const chatId = this.resultChatId(record);
      if (chatId && this.deps.chats.hasEntry(chatId, id))
        seq = this.deps.chats.findEntry(chatId, id)?.seq;
      else if (chatId) {
        const saved = this.deps.chats.appendEntry(chatId, {
          kind: 'bot',
          id,
          at: Date.now(),
          botId: record.targetBotId,
          text: record.result ?? '',
          conversationId: record.childConversationId,
          turnId: record.pendingResultEntry.turnId || record.id,
          delegationId: record.id,
          ...(this.resultSeen(record) ? { hiddenFrom: record.parentBotId } : {}),
        });
        if (saved) {
          seq = saved.seq;
          this.deps.emit({ kind: 'timeline', chatId, seq: saved.seq });
        } else {
          // 群有效时只有条目校验失败才会返回 undefined；校验是确定性的，保留标记只会每次启动重试同样失败
          console.warn('[bots] delegation result entry rejected, not retrying:', record.id);
        }
      }
    } catch (cause) {
      console.warn('[bots] delegation result post failed', cause);
      return;
    }
    const latest = this.deps.store.get(record.id);
    if (!latest) return;
    const { pendingResultEntry: _pending, ...rest } = latest;
    this.save(seq === undefined ? rest : { ...rest, resultSeq: seq });
  }

  /** 发起人是否已随委派回传收到过这条结果的全文 */
  private resultSeen(record: Delegation): boolean {
    if (this.deps.store.get(record.id)?.deliveredAt !== undefined) return true;
    const batch = delegationBatches(this.deps.store.list()).find((items) =>
      items.some((item) => item.id === record.id)
    );
    return Boolean(
      batch &&
        this.deps.host.hasStartedDelivery(record.parentConversationId, batchDeliveryId(batch))
    );
  }

  /** 同一子会话上的续跑链从最初那次委派起算 */
  private startedAt(record: Delegation): number {
    let start = record;
    for (
      let prev = record.retryOf ? this.deps.store.get(record.retryOf) : undefined;
      prev?.childConversationId === record.childConversationId;
      prev = prev.retryOf ? this.deps.store.get(prev.retryOf) : undefined
    )
      start = prev;
    return start.createdAt;
  }

  /** 批次未齐：在群时间线提示谁结束了、还在等谁 */
  private noticeWaiting(record: Delegation): void {
    if (this.disposed || this.discarding || !record.batchId || !record.chatId) return;
    if (this.deps.chats.get(record.chatId)?.kind !== 'group') return;
    const batch = this.deps.store
      .list()
      .filter(
        (item) =>
          item.parentConversationId === record.parentConversationId &&
          item.batchId === record.batchId
      );
    const text = batchWaitingNotice(batch, record, (id) => this.deps.bots.get(id)?.name ?? id);
    if (!text) return;
    const saved = this.deps.chats.appendEntry(record.chatId, {
      kind: 'system',
      id: randomUUID(),
      at: Date.now(),
      text,
    });
    if (saved) this.deps.emit({ kind: 'timeline', chatId: record.chatId, seq: saved.seq });
  }

  private delivered(batch: readonly Delegation[]): void {
    const superseded = supersededIds(batch);
    for (const record of batch) {
      let latest = this.deps.store.get(record.id);
      if (!latest || latest.deliveredAt !== undefined) continue;
      // 结果已被消费 / 作废：排定中的自动重试一并放弃
      if (latest.autoRetryAt !== undefined && pendingAutoRetry(latest, this.deps.store.list())) {
        clearTimeout(this.retryTimers.get(latest.id));
        this.retryTimers.delete(latest.id);
        const { autoRetryAt: _at, ...rest } = latest;
        latest = rest;
      }
      // 被自动重试接替的中间记录不单独出卡片，卡片只给接替链最后那条
      if (
        !superseded.has(record.id) &&
        record.chatId &&
        this.deps.chats.get(record.chatId)?.kind === 'group'
      ) {
        if (!this.deps.chats.hasEntry(record.chatId, `delegation:${record.id}`))
          this.deps.chats.appendEntry(record.chatId, {
            kind: 'delegation',
            id: `delegation:${record.id}`,
            at: Date.now(),
            delegationId: record.id,
            from: record.parentBotId,
            to: record.targetBotId,
            state: record.state,
            // 结果全文已作为成员消息入群：卡片不再带摘要，避免上下文里重复出现
            ...(latest.resultSeq === undefined
              ? { summary: delegationResultBody(record).slice(0, 500) }
              : {}),
            ...(record.taskId ? { taskId: record.taskId } : {}),
          });
        this.deps.emit({ kind: 'timeline', chatId: record.chatId });
      }
      this.save({ ...latest, deliveredAt: Date.now() });
    }
  }

  private save(record: Delegation): void {
    this.deps.store.save(record);
    const nestedIn = record.taskId ? undefined : this.nestedIn(record);
    if (nestedIn) this.deps.tasks?.sync(record, nestedIn);
    else this.deps.tasks?.sync(record);
    this.deps.emit({ kind: 'delegation', ...(record.chatId ? { chatId: record.chatId } : {}) });
  }

  /** 嵌套执行所属的上层任务：发起它的那次执行（父会话上最近一条记录）挂的任务 */
  private nestedIn(record: Delegation): string | undefined {
    if (record.depth < 2) return undefined;
    return this.executionOf(record.parentConversationId)?.taskId;
  }
}
