import type { SlashCommand } from '@shared/types/agent';
import { useSyncExternalStore } from 'react';

export interface PluginCommandRef {
  pluginId: string;
  pluginName: string;
  id: string;
  title: string;
}

let commands: PluginCommandRef[] = [];
let slash: SlashCommand[] = [];
const listeners = new Set<() => void>();

const slashName = (command: PluginCommandRef) => `/${command.pluginId}:${command.id}`;

/** 已启用插件声明的命令，由 PluginUiHost 随插件列表刷新 */
export function setPluginCommands(next: PluginCommandRef[]): void {
  commands = next;
  slash = next.map((command) => ({
    name: slashName(command),
    description: `${command.title} · ${command.pluginName}`,
  }));
  for (const listener of listeners) listener();
}

export function pluginSlashCommands(): SlashCommand[] {
  return slash;
}

export function pluginCommandFor(name: string): PluginCommandRef | null {
  return commands.find((command) => slashName(command) === name) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePluginSlashCommands(): SlashCommand[] {
  return useSyncExternalStore(subscribe, pluginSlashCommands, pluginSlashCommands);
}

/** 选中即执行，算用户操作；失败返回错误文本 */
export async function runPluginCommand(
  command: PluginCommandRef,
  sessionId: string | null
): Promise<string | null> {
  const res = await window.electronAPI.extensionPlugins.call({
    pluginId: command.pluginId,
    method: 'command.run',
    payload: { id: command.id },
    sessionId,
  });
  return res.ok ? null : res.error;
}
