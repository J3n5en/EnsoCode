import { app } from '@platform';
import { isTriggerId } from '@shared/secretary/triggers';
import { applyProxySettings } from '../../ipc/proxy';
import {
  patchSettingsState,
  readSettingsState,
  reloadSettingsFromDisk,
  SETTINGS_STATE_FIELDS,
} from '../../ipc/settings';
import { secretaryEnabled } from '../secretary/enabled';
import { type SecretaryContext, secretaryContexts } from '../secretary/secretaries';
import { SecretaryStore } from '../secretary/store';
import { getActiveTriggerManager } from '../secretary/triggers/tools';
import { type ConfigCliHandle, startConfigCli, type TriggerCliPort } from './server';

let handle: ConfigCliHandle | null = null;

function listSecretaryMeta(): { id: string; name: string | null; ctx: SecretaryContext }[] {
  return secretaryContexts().map((ctx) => ({
    id: ctx.id,
    name: new SecretaryStore(ctx.dir).profile()?.name ?? null,
    ctx,
  }));
}

/** 支持按 secretaryId 或秘书名字（大小写不敏感）定位；只有 1 个秘书时可省略 */
function resolveCliSecretary(
  raw: unknown
): { ok: true; id: string; name: string | null } | { ok: false; error: string } {
  const all = listSecretaryMeta();
  if (raw === undefined || raw === null || raw === '') {
    if (all.length === 1) return { ok: true, id: all[0].id, name: all[0].name };
    return {
      ok: false,
      error:
        all.length === 0
          ? 'no secretary configured'
          : `multiple secretaries exist (${all.map((s) => `${s.name ?? s.id} [${s.id}]`).join(', ')}); pass --secretary <id|name>`,
    };
  }
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'invalid secretary' };
  const needle = raw.trim().toLowerCase();
  const byId = all.find((item) => item.id.toLowerCase() === needle);
  if (byId) return { ok: true, id: byId.id, name: byId.name };
  const byName = all.find((item) => item.name?.trim().toLowerCase() === needle);
  if (byName) return { ok: true, id: byName.id, name: byName.name };
  return {
    ok: false,
    error: `secretary not found: ${raw.trim()} (available: ${all.map((s) => `${s.name ?? s.id} [${s.id}]`).join(', ') || 'none'})`,
  };
}

export function createTriggerCliPort(): TriggerCliPort {
  return {
    async handle(request) {
      if (!secretaryEnabled()) return { ok: false, error: 'secretary is disabled' };
      const manager = getActiveTriggerManager();
      if (!manager) return { ok: false, error: 'trigger service unavailable' };
      const action = typeof request.action === 'string' ? request.action : '';

      if (action === 'port') {
        return manager.setPort(request.port);
      }

      if (action === 'list') {
        const all = listSecretaryMeta();
        if (
          request.secretary !== undefined &&
          request.secretary !== null &&
          request.secretary !== ''
        ) {
          const resolved = resolveCliSecretary(request.secretary);
          if (!resolved.ok) return resolved;
          const listed = await manager.list(resolved.id);
          return {
            ok: true,
            secretary: { id: resolved.id, name: resolved.name },
            server: listed.server,
            triggers: listed.triggers,
          };
        }
        const secretaries = await Promise.all(
          all.map(async (item) => {
            const listed = await manager.list(item.id);
            return { id: item.id, name: item.name, triggers: listed.triggers };
          })
        );
        return { ok: true, server: manager.serverState(), secretaries };
      }

      const resolved = resolveCliSecretary(request.secretary);
      if (!resolved.ok) return resolved;

      if (action === 'create') {
        const created = await manager.create(resolved.id, request.draft);
        if (!created.ok) return created;
        return {
          ok: true,
          secretary: { id: resolved.id, name: resolved.name },
          trigger: created.trigger,
          token: created.token,
          server: created.server,
        };
      }

      const triggerId = request.triggerId;
      if (!isTriggerId(triggerId)) return { ok: false, error: 'invalid triggerId' };

      if (action === 'update') {
        const updated = await manager.update(resolved.id, triggerId, request.patch);
        if (!updated.ok) return updated;
        return { ...updated, secretary: { id: resolved.id, name: resolved.name } };
      }
      if (action === 'remove') {
        return manager.remove(resolved.id, triggerId);
      }
      if (action === 'rotate-token') {
        return manager.rotateToken(resolved.id, triggerId);
      }
      if (action === 'test') {
        const text = typeof request.text === 'string' ? request.text : undefined;
        return manager.testFire(resolved.id, triggerId, text);
      }
      return { ok: false, error: `unknown trigger action: ${action}` };
    },
  };
}

/** 写入走与 UI 相同的 Main 设置入口：更新内存副本、广播 renderer、推送 agent worker、防抖落盘 */
export async function startDesktopConfigCli(): Promise<void> {
  try {
    handle = await startConfigCli(app.getPath('userData'), {
      fields: SETTINGS_STATE_FIELDS,
      readState: readSettingsState,
      patch: (field, value) => patchSettingsState(field, value, undefined, 'all-renderers'),
      reload: reloadSettingsFromDisk,
      applyProxy: (mode, customUrl) => applyProxySettings({ mode, customUrl }),
      triggers: createTriggerCliPort(),
    });
  } catch (error) {
    console.warn('[config-cli] listen failed', error);
  }
}

export function stopDesktopConfigCli(): void {
  handle?.close();
  handle = null;
}
