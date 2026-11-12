import type { PluginStatusItem, StatusTone } from '@shared/extensionPlugins/statusItems';
import type { ExtensionPluginSummary } from '@shared/extensionPlugins/types';
import { useSyncExternalStore } from 'react';
import { addToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { pluginCommands, runPluginCommand } from './commands';

export interface PluginStatusRef extends PluginStatusItem {
  pluginId: string;
  pluginName: string;
}

/** 已启用插件里可见的状态项，按插件列表顺序 */
export function pluginStatusRefs(list: readonly ExtensionPluginSummary[]): PluginStatusRef[] {
  return list
    .filter((plugin) => plugin.state === 'enabled')
    .flatMap((plugin) =>
      (plugin.statusItems ?? [])
        .filter((item) => item.visible && item.text.trim().length > 0)
        .map((item) => ({ ...item, pluginId: plugin.id, pluginName: plugin.name }))
    );
}

let items: PluginStatusRef[] = [];
const listeners = new Set<() => void>();

export function setPluginStatusItems(next: PluginStatusRef[]): void {
  items = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => items;

const TONE: Record<StatusTone, string> = {
  neutral: 'text-muted-foreground',
  accent: 'text-primary',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
};

/** 输入框底栏的插件状态项；有 command 的可点，对当前会话执行 */
export function PluginStatusItems({ sessionId }: { sessionId: string | null }) {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (list.length === 0) return null;
  return (
    <>
      {list.map((item) => {
        const command = item.command
          ? pluginCommands().find((c) => c.pluginId === item.pluginId && c.id === item.command)
          : undefined;
        const className = cn('shrink-0 truncate px-1 text-[11px]', TONE[item.tone]);
        const title = item.tooltip ? `${item.tooltip} · ${item.pluginName}` : item.pluginName;
        return command ? (
          <button
            key={`${item.pluginId}:${item.id}`}
            type="button"
            title={title}
            className={cn(className, 'rounded hover:bg-accent')}
            onClick={() =>
              void runPluginCommand(command, sessionId).then((error) => {
                if (error) addToast({ title: error });
              })
            }
          >
            {item.text}
          </button>
        ) : (
          <span key={`${item.pluginId}:${item.id}`} title={title} className={className}>
            {item.text}
          </span>
        );
      })}
    </>
  );
}
