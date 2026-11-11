import type { PluginCommandRef } from './commands';

/** 插件命令在快捷键设置里的动作名，与内置动作共用 settings.keybindings */
export const pluginKeybindingAction = (pluginId: string, commandId: string) =>
  `plugin:${pluginId}:${commandId}`;

export interface PluginKeybindingRow {
  action: string;
  command: PluginCommandRef;
  binding: string;
  custom: boolean;
  /** 被占用时的占用方：内置动作名或另一条插件动作名；此时本条不生效 */
  conflict?: string;
}

/** 内置快捷键优先，其次按插件列表顺序先到先得 */
export function resolvePluginKeybindings(
  commands: readonly PluginCommandRef[],
  overrides: Record<string, string>,
  builtin: Record<string, string>
): { rows: PluginKeybindingRow[]; byBinding: Map<string, PluginCommandRef> } {
  const taken = new Map<string, string>();
  for (const [action, binding] of Object.entries(builtin)) if (binding) taken.set(binding, action);
  const byBinding = new Map<string, PluginCommandRef>();
  const rows = commands.map((command) => {
    const action = pluginKeybindingAction(command.pluginId, command.id);
    const custom = overrides[action] !== undefined;
    const binding = custom ? overrides[action] : (command.key ?? '');
    const conflict = binding ? taken.get(binding) : undefined;
    if (binding && !conflict) {
      taken.set(binding, action);
      byBinding.set(binding, command);
    }
    return { action, command, binding, custom, ...(conflict ? { conflict } : {}) };
  });
  return { rows, byBinding };
}
