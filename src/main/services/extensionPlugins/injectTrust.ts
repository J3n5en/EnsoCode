import type { ExtensionPluginPermission } from '@shared/extensionPlugins/manifest';
import type { PluginInstallSource } from './install';

/**
 * 临时过渡：这三个官方插件投递的是用户自己定的任务，旧版还不会声明 agent.injectTrusted。
 * 只认从市场装的；插件声明了这项权限后自动不再兜底。三个插件都发了新版就删掉。
 */
const LEGACY_TRUSTED_INJECT = new Set(['enso.scheduler', 'enso.kanban', 'enso.bridge']);

/** 一次投递能否免去不可信包裹；ignored 表示插件要了 trusted 但没有权限 */
export function resolveInjectTrust(input: {
  pluginId: string;
  requested: boolean;
  permissions: readonly ExtensionPluginPermission[];
  source?: PluginInstallSource;
}): { trusted: boolean; ignored: boolean } {
  if (input.permissions.includes('agent.injectTrusted'))
    return { trusted: input.requested, ignored: false };
  const legacy =
    LEGACY_TRUSTED_INJECT.has(input.pluginId) &&
    input.source?.kind === 'market' &&
    input.source.id === input.pluginId;
  return { trusted: legacy, ignored: input.requested && !legacy };
}
