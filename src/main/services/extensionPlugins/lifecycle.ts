import type { PluginGrant } from '@shared/extensionPlugins/grant';
import type { PluginInstallSource } from './install';

export const PLUGIN_STATES = ['disabled', 'enabled', 'crashed'] as const;
export type PluginState = (typeof PLUGIN_STATES)[number];

/** 已安装插件的权威记录；`dir` 是 packages/<id>/ 下的随机安装目录名，不用版本号拼路径 */
export interface PluginRecord {
  id: string;
  version: string;
  dir: string;
  state: PluginState;
  grant: PluginGrant;
  installedAt: number;
  /** 用户单独允许该插件向非发起会话注入消息；默认关 */
  crossSessionInject: boolean;
  /** 更新扩大了授权、等用户同意的新版本；期间旧版本照常运行 */
  pending?: { version: string; dir: string; grant: PluginGrant };
  /** 最近一次崩溃停用的原因；重新启用时清掉 */
  lastError?: { at: number; message: string };
  /** 最近一次安装的来源，用于重新安装；只在 Main 里用，路径不下发给界面 */
  source?: PluginInstallSource;
}

export type PluginAction =
  | { type: 'enable' }
  | { type: 'disable' }
  | { type: 'crash' }
  | { type: 'update'; version: string; dir: string; grant: PluginGrant; expands: boolean }
  | { type: 'approve-pending' }
  | { type: 'reject-pending' };

export function applyPluginAction(
  record: PluginRecord,
  action: PluginAction
): PluginRecord | { error: string } {
  switch (action.type) {
    case 'enable':
      if (record.state === 'enabled') return record;
      return { ...withoutLastError(record), state: 'enabled' };
    case 'disable':
      return { ...record, state: 'disabled' };
    case 'crash':
      return record.state === 'enabled' ? { ...record, state: 'crashed' } : { error: '插件未启用' };
    case 'update': {
      const { pending: _stale, ...rest } = record;
      const next = { version: action.version, dir: action.dir, grant: action.grant };
      return action.expands ? { ...rest, pending: next } : { ...rest, ...next };
    }
    case 'approve-pending': {
      if (!record.pending) return { error: '没有待授权的更新' };
      const { pending, ...rest } = record;
      return { ...rest, ...pending };
    }
    case 'reject-pending': {
      if (!record.pending) return { error: '没有待授权的更新' };
      const { pending: _rejected, ...rest } = record;
      return rest;
    }
  }
}

function withoutLastError(record: PluginRecord): PluginRecord {
  const { lastError: _cleared, ...rest } = record;
  return rest;
}
