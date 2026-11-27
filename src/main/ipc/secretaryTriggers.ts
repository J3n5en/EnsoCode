import { ipcMain } from '@platform';
import { isTriggerId } from '@shared/secretary/triggers';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type { SecretaryTriggerServerState } from '@shared/types/secretary';
import { broadcastToRenderers, isMainRenderer } from '../services/renderers';
import { appendAudit } from '../services/secretary/audit';
import { secretaryEnabled } from '../services/secretary/enabled';
import {
  resolveSecretaryRequest,
  secretaryContext,
  secretaryContexts,
  secretaryRoot,
} from '../services/secretary/secretaries';
import { TriggerManager } from '../services/secretary/triggers';
import { setActiveTriggerManager } from '../services/secretary/triggers/tools';

export interface SecretaryTriggersDeps {
  /** 事件入队后通知对应秘书的宿主排一次投递（立即或按合并窗口） */
  onEnqueued(secretaryId: string, deliverAt?: number): void;
}

export interface SecretaryTriggers {
  register(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  sync(): Promise<void>;
  onSecretaryRemoved(secretaryId: string): Promise<void>;
  serverState(): SecretaryTriggerServerState;
}

const NO_SECRETARY = { ok: false as const, error: 'secretary-required' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 秘书本机触发器 IPC 与服务装配：
 * - 严格按 unknown 收窄所有入参
 * - Token 明文保留在 Main（加密落盘），只在创建/重置/显式查看时返回
 */
export function createSecretaryTriggers(deps: SecretaryTriggersDeps): SecretaryTriggers {
  const broadcastChanged = () => {
    broadcastToRenderers(IPC_CHANNELS.SECRETARY_TRIGGERS_CHANGED, {
      server: manager.serverState(),
    });
  };

  const manager = new TriggerManager({
    rootDir: () => secretaryRoot(),
    enabled: () => secretaryEnabled(),
    secretaries: () => secretaryContexts().map((ctx) => ({ id: ctx.id, dir: ctx.dir })),
    secretary: (id) => {
      const ctx = secretaryContext(id);
      return ctx ? { id: ctx.id, dir: ctx.dir } : null;
    },
    onEnqueued: deps.onEnqueued,
    onChanged: broadcastChanged,
    audit: appendAudit,
  });
  setActiveTriggerManager(manager);

  return {
    register() {
      ipcMain.handle(IPC_CHANNELS.SECRETARY_TRIGGERS_LIST, async (event, secretaryId: unknown) => {
        if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
        if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
        const ctx = resolveSecretaryRequest(secretaryId);
        if (!ctx) return NO_SECRETARY;
        const listed = await manager.list(ctx.id);
        return { ok: true, ...listed };
      });

      ipcMain.handle(
        IPC_CHANNELS.SECRETARY_TRIGGER_CREATE,
        async (event, request: unknown, secretaryId: unknown) => {
          if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
          if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
          const ctx = resolveSecretaryRequest(secretaryId);
          if (!ctx) return NO_SECRETARY;
          return manager.create(ctx.id, request);
        }
      );

      ipcMain.handle(
        IPC_CHANNELS.SECRETARY_TRIGGER_UPDATE,
        async (event, request: unknown, secretaryId: unknown) => {
          if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
          if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
          const ctx = resolveSecretaryRequest(secretaryId);
          if (!ctx) return NO_SECRETARY;
          if (!isRecord(request) || !isTriggerId(request.id))
            return { ok: false, error: 'invalid request' };
          return manager.update(ctx.id, request.id, request.patch);
        }
      );

      ipcMain.handle(
        IPC_CHANNELS.SECRETARY_TRIGGER_REMOVE,
        async (event, request: unknown, secretaryId: unknown) => {
          if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
          if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
          const ctx = resolveSecretaryRequest(secretaryId);
          if (!ctx) return NO_SECRETARY;
          const id = isRecord(request) ? request.id : request;
          if (!isTriggerId(id)) return { ok: false, error: 'invalid request' };
          return manager.remove(ctx.id, id);
        }
      );

      ipcMain.handle(
        IPC_CHANNELS.SECRETARY_TRIGGER_ROTATE_TOKEN,
        async (event, request: unknown, secretaryId: unknown) => {
          if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
          if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
          const ctx = resolveSecretaryRequest(secretaryId);
          if (!ctx) return NO_SECRETARY;
          const id = isRecord(request) ? request.id : request;
          if (!isTriggerId(id)) return { ok: false, error: 'invalid request' };
          return manager.rotateToken(ctx.id, id);
        }
      );

      ipcMain.handle(
        IPC_CHANNELS.SECRETARY_TRIGGER_REVEAL_TOKEN,
        async (event, request: unknown, secretaryId: unknown) => {
          if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
          if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
          const ctx = resolveSecretaryRequest(secretaryId);
          if (!ctx) return NO_SECRETARY;
          const id = isRecord(request) ? request.id : request;
          if (!isTriggerId(id)) return { ok: false, error: 'invalid request' };
          return manager.revealToken(ctx.id, id);
        }
      );

      ipcMain.handle(IPC_CHANNELS.SECRETARY_TRIGGER_SET_PORT, async (event, request: unknown) => {
        if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
        if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
        const port = isRecord(request) ? request.port : request;
        return manager.setPort(port);
      });

      ipcMain.handle(
        IPC_CHANNELS.SECRETARY_TRIGGER_TEST,
        async (event, request: unknown, secretaryId: unknown) => {
          if (!isMainRenderer(event.sender.id)) return { ok: false, error: 'invalid sender' };
          if (!secretaryEnabled()) return { ok: false, error: 'disabled' };
          const ctx = resolveSecretaryRequest(secretaryId);
          if (!ctx) return NO_SECRETARY;
          if (!isRecord(request) || !isTriggerId(request.id))
            return { ok: false, error: 'invalid request' };
          const text = typeof request.text === 'string' ? request.text : undefined;
          return manager.testFire(ctx.id, request.id, text);
        }
      );
    },

    start: () => manager.start(),
    stop: () => manager.stop(),
    sync: () => manager.syncServer(),
    onSecretaryRemoved: (secretaryId) => manager.onSecretaryRemoved(secretaryId),
    serverState: () => manager.serverState(),
  };
}
