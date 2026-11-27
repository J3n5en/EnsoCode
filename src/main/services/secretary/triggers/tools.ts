import { isTriggerId } from '@shared/secretary/triggers';
import type { SecretaryContext } from '../secretaries';
import type { SecretaryOpHandler } from '../tools';
import type { TriggerManager } from './service';

export type SecretaryTriggerOp =
  | 'trigger_list'
  | 'trigger_create'
  | 'trigger_update'
  | 'trigger_remove'
  | 'trigger_rotate_token'
  | 'trigger_test';

export type SecretaryTriggerHandlers = Record<SecretaryTriggerOp, SecretaryOpHandler>;

let activeManager: TriggerManager | null = null;

/** 由 Main 装配入口注入运行中的 TriggerManager，供秘书工具与 CLI 共享同一实例 */
export function setActiveTriggerManager(manager: TriggerManager | null): void {
  activeManager = manager;
}

export function getActiveTriggerManager(): TriggerManager | null {
  return activeManager;
}

const RESTRICTED_ERROR = {
  ok: false as const,
  error: 'forbidden in downgraded colleague turn',
};

const UNAVAILABLE_ERROR = {
  ok: false as const,
  error: 'trigger service unavailable',
};

export function createSecretaryTriggerHandlers(
  ctx: SecretaryContext,
  options?: { restricted?: boolean; manager?: () => TriggerManager | null }
): SecretaryTriggerHandlers {
  const restricted = options?.restricted === true;
  const getManager = options?.manager ?? getActiveTriggerManager;

  return {
    async trigger_list() {
      const manager = getManager();
      if (!manager) return UNAVAILABLE_ERROR;
      const listed = await manager.list(ctx.id);
      return { ok: true, result: listed };
    },

    async trigger_create(params) {
      if (restricted) return RESTRICTED_ERROR;
      const manager = getManager();
      if (!manager) return UNAVAILABLE_ERROR;
      const created = await manager.create(ctx.id, params);
      if (!created.ok) return created;
      return {
        ok: true,
        result: {
          trigger: created.trigger,
          token: created.token,
          server: created.server,
          usage: {
            httpPost: `curl -X POST ${created.trigger.httpUrl} -H "Authorization: Bearer ${created.token}" -H "Content-Type: application/json" -d '{"eventId":"unique-id","source":"watcher","text":"hello"}'`,
            wsUrl: created.trigger.wsUrl,
            wsAuthHeader: `Authorization: Bearer ${created.token}`,
            wsAuthFrame: { type: 'auth', token: created.token },
            wsEventFrame: {
              type: 'event',
              id: 'req-1',
              eventId: 'unique-id',
              source: 'watcher',
              text: 'hello',
            },
          },
        },
      };
    },

    async trigger_update(params) {
      if (restricted) return RESTRICTED_ERROR;
      const manager = getManager();
      if (!manager) return UNAVAILABLE_ERROR;
      const triggerId = params.triggerId;
      if (!isTriggerId(triggerId)) return { ok: false, error: 'invalid triggerId' };
      const patch: Record<string, unknown> = {};
      if ('name' in params) patch.name = params.name;
      if ('enabled' in params) patch.enabled = params.enabled;
      if ('coalesceMs' in params) patch.coalesceMs = params.coalesceMs;
      if ('instruction' in params) {
        patch.instruction =
          typeof params.instruction === 'string' && params.instruction.trim() === ''
            ? null
            : params.instruction;
      }
      const updated = await manager.update(ctx.id, triggerId, patch);
      if (!updated.ok) return updated;
      return { ok: true, result: { trigger: updated.trigger, server: updated.server } };
    },

    async trigger_remove(params) {
      if (restricted) return RESTRICTED_ERROR;
      const manager = getManager();
      if (!manager) return UNAVAILABLE_ERROR;
      const triggerId = params.triggerId;
      if (!isTriggerId(triggerId)) return { ok: false, error: 'invalid triggerId' };
      const removed = await manager.remove(ctx.id, triggerId);
      if (!removed.ok) return removed;
      return { ok: true, result: { triggerId, server: removed.server } };
    },

    async trigger_rotate_token(params) {
      if (restricted) return RESTRICTED_ERROR;
      const manager = getManager();
      if (!manager) return UNAVAILABLE_ERROR;
      const triggerId = params.triggerId;
      if (!isTriggerId(triggerId)) return { ok: false, error: 'invalid triggerId' };
      const rotated = await manager.rotateToken(ctx.id, triggerId);
      if (!rotated.ok) return rotated;
      return { ok: true, result: { triggerId, token: rotated.token } };
    },

    async trigger_test(params) {
      if (restricted) return RESTRICTED_ERROR;
      const manager = getManager();
      if (!manager) return UNAVAILABLE_ERROR;
      const triggerId = params.triggerId;
      if (!isTriggerId(triggerId)) return { ok: false, error: 'invalid triggerId' };
      const text = typeof params.text === 'string' ? params.text : undefined;
      const tested = await manager.testFire(ctx.id, triggerId, text);
      if (!tested.ok) return tested;
      return { ok: true, result: { triggerId, deliveryKey: tested.deliveryKey } };
    },
  };
}
