import { randomUUID } from 'node:crypto';
import { parseProfile } from '@shared/secretary/parse';
import {
  intersectProjectSets,
  nextPeerLink,
  PEER_MESSAGE_MAX,
  PeerRateLimiter,
  peerTriggerOf,
} from '@shared/secretary/peers';
import { restrictProfileToProjects } from '@shared/secretary/policy';
import type { SecretaryProfile, SecretaryTodo, SecretaryUpdate } from '@shared/types/secretary';
import { getSourceAuthorityRegistry } from '../../ipc/agent';
import { appendAudit } from './audit';
import { visibleProjects } from './readers';
import { enqueueUpdate } from './results';
import { type SecretaryContext, secretaryContext, secretaryContexts } from './secretaries';
import { SecretaryStore } from './store';
import type { SecretaryOpHandler, SecretaryOpResult } from './tools';

/**
 * 秘书之间的沟通：secretary_list 认识同事，secretary_message 给同事发一句话。
 * 消息走对方的投递队列；链与跳数由 Main 按「这一回合是不是同事消息触发的」判定，
 * 模型自己报的链一律不认。
 */

const limiter = new PeerRateLimiter();
let deliveryListener: ((secretaryId: string) => void) | null = null;

/** 新消息进了某个秘书的队列：让它的宿主立刻试投，不等下一分钟的 tick */
export function setPeerDeliveryListener(listener: ((secretaryId: string) => void) | null): void {
  deliveryListener = listener;
}

function profileOf(ctx: SecretaryContext): SecretaryProfile {
  return new SecretaryStore(ctx.dir).profile() ?? (parseProfile({}) as SecretaryProfile);
}

function nameOf(ctx: SecretaryContext): string {
  return new SecretaryStore(ctx.dir).profile()?.name ?? ctx.id;
}

function personaLine(ctx: SecretaryContext): string {
  const line = new SecretaryStore(ctx.dir)
    .readPersona()
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  return (line ?? '').slice(0, 120);
}

function visibleIds(ctx: SecretaryContext): string[] {
  const projects = getSourceAuthorityRegistry()?.projection().projects ?? [];
  return visibleProjects(projects, profileOf(ctx)).map((project) => project.projectId);
}

/**
 * 降权回合：这个秘书会话的当前回合由同事消息触发时，返回把档案收窄到
 * 「接收方与链上所有发起方可见项目交集」的函数；不是这种回合返回 null。
 */
export function turnRestriction(
  secretaryId: string,
  conversationId: string
): ((profile: SecretaryProfile) => SecretaryProfile) | null {
  const self = secretaryContext(secretaryId);
  if (!self) return null;
  const trigger = peerTriggerOf(new SecretaryStore(self.dir).dispatch(), conversationId);
  if (!trigger) return null;
  const sets = [visibleIds(self)];
  for (const origin of trigger.origins) {
    const ctx = secretaryContext(origin);
    // 发起方已经删掉了：它的范围不可知，按空集处理，宁可什么都不让做
    sets.push(ctx ? visibleIds(ctx) : []);
  }
  const allowed = intersectProjectSets(sets);
  return (profile) => restrictProfileToProjects(profile, allowed);
}

function findTarget(self: SecretaryContext, raw: string): SecretaryContext | null {
  const wanted = raw.trim().toLocaleLowerCase();
  if (!wanted) return null;
  for (const ctx of secretaryContexts()) {
    if (ctx.id === self.id) continue;
    if (ctx.id === wanted || nameOf(ctx).trim().toLocaleLowerCase() === wanted) return ctx;
  }
  return null;
}

function audit(
  ctx: SecretaryContext,
  conversationId: string | null,
  op: string,
  ok: boolean,
  detail?: string,
  targetId?: string
): void {
  appendAudit(ctx.dir, {
    at: Date.now(),
    secretaryConversationId: conversationId,
    op,
    ok,
    ...(targetId ? { targetId } : {}),
    ...(detail ? { detail } : {}),
  });
}

/** 写进目标秘书的投递队列：只走它自己的文件，读改写之间不留 await */
function deliver(target: SecretaryContext, update: SecretaryUpdate): void {
  const store = new SecretaryStore(target.dir);
  const file = store.dispatch();
  file.outbox = enqueueUpdate(file.outbox, update);
  store.saveDispatch(file);
  deliveryListener?.(target.id);
}

function addTodo(target: SecretaryContext, from: SecretaryContext, text: string): string {
  const store = new SecretaryStore(target.dir);
  const now = Date.now();
  const todo: SecretaryTodo = {
    id: randomUUID(),
    text: text.slice(0, PEER_MESSAGE_MAX),
    createdAt: now,
    updatedAt: now,
    from: { secretaryId: from.id, name: nameOf(from) },
  };
  store.saveTodos([...store.todos(), todo]);
  return todo.id;
}

export function peerHandlersFor(ctx: SecretaryContext): {
  secretary_list: SecretaryOpHandler;
  secretary_message: SecretaryOpHandler;
} {
  return {
    secretary_list() {
      const colleagues = secretaryContexts()
        .filter((other) => other.id !== ctx.id)
        .map((other) => ({
          secretaryId: other.id,
          name: nameOf(other),
          ...(personaLine(other) ? { persona: personaLine(other) } : {}),
        }));
      return { ok: true, result: { colleagues } };
    },

    secretary_message(params, op): SecretaryOpResult {
      const conversationId = op.secretaryConversationId;
      const to = typeof params.to === 'string' ? params.to : '';
      const text = typeof params.text === 'string' ? params.text.trim() : '';
      const asTodo = params.asTodo === true;
      if (!conversationId || !to || !text || text.length > PEER_MESSAGE_MAX) {
        return { ok: false, error: 'invalid arguments' };
      }
      const target = findTarget(ctx, to);
      if (!target) {
        audit(ctx, conversationId, 'secretary_message', false, 'not-found');
        return { ok: false, error: 'not found: no other secretary with this id or name' };
      }
      const trigger = peerTriggerOf(new SecretaryStore(ctx.dir).dispatch(), conversationId);
      const link = nextPeerLink(trigger, ctx.id, () => randomUUID());
      if (!link.ok) {
        audit(ctx, conversationId, 'secretary_message', false, 'chain-limit', target.id);
        return {
          ok: false,
          error:
            'refused (chain-limit): this back-and-forth between secretaries has reached its hop limit. Stop messaging and tell the user what is still open.',
        };
      }
      const now = Date.now();
      if (limiter.check(ctx.id, target.id, now) !== 'ok') {
        audit(ctx, conversationId, 'secretary_message', false, 'rate-limited', target.id);
        return {
          ok: false,
          error: 'refused (rate-limited): too many messages to other secretaries; try later.',
        };
      }
      limiter.record(ctx.id, target.id, now);
      const todoId = asTodo ? addTodo(target, ctx, text) : undefined;
      deliver(target, {
        key: `peer:${link.chain}:${link.hop}:${ctx.id}:${randomUUID()}`,
        at: now,
        text: todoId ? `${text}\n(added to your todo list: ${todoId})` : text,
        kind: 'peer-message',
        fromSecretaryId: ctx.id,
        fromName: nameOf(ctx),
        chain: link.chain,
        hop: link.hop,
        origins: link.origins,
      });
      const detail = `to=${target.id} chain=${link.chain} hop=${link.hop}${todoId ? ' todo' : ''}`;
      audit(ctx, conversationId, 'secretary_message', true, detail, target.id);
      audit(target, null, 'secretary_message_received', true, `from=${ctx.id} hop=${link.hop}`);
      return {
        ok: true,
        result: {
          delivered: true,
          to: { secretaryId: target.id, name: nameOf(target) },
          chain: link.chain,
          hop: link.hop,
          ...(todoId ? { todoId } : {}),
        },
      };
    },
  };
}

/**
 * 同事托付的待办办完或出了问题：给发起的秘书回一条系统回执（hop 0，不计跳数、不降权）。
 * 同一个终态只回一次。返回是否改了待办。
 */
export function reportPeerTodos(ctx: SecretaryContext): boolean {
  const store = new SecretaryStore(ctx.dir);
  const todos = store.todos();
  let changed = false;
  const next = todos.map((todo): SecretaryTodo => {
    if (!todo.from) return todo;
    const state: SecretaryTodo['reportedAs'] = todo.doneAt !== undefined ? 'done' : todo.problem;
    if (!state || todo.reportedAs === state) return todo;
    const origin = secretaryContext(todo.from.secretaryId);
    changed = true;
    if (origin) {
      const now = Date.now();
      deliver(origin, {
        key: `peer-todo:${todo.id}:${state}`,
        at: now,
        text: `${state === 'done' ? 'Done' : `Problem (${state})`}: ${todo.text.split('\n')[0] ?? ''}`,
        kind: 'peer-message',
        fromSecretaryId: ctx.id,
        fromName: nameOf(ctx),
        chain: `todo:${todo.id}`,
        hop: 0,
        origins: [ctx.id],
      });
    }
    return { ...todo, reportedAs: state };
  });
  if (changed) store.saveTodos(next);
  return changed;
}
