/** 会话中途可开关的内置工具。isolated_sandbox / workspace_write / goal 仍在 spawn 时定型。 */
export const HOT_BUILTIN_TOOL_IDS = [
  'image_generation',
  'subagent',
  'workflow',
  'todo',
  'plan',
  'ask_user',
  'browser',
  'web',
  'background_tasks',
  'memory',
  'computer',
  'turn_discard',
] as const;

export function enabledHotBuiltins(disabled: readonly string[]): Set<string> {
  const off = new Set(disabled);
  return new Set(
    HOT_BUILTIN_TOOL_IDS.filter((id) => !off.has(id) && (id !== 'workflow' || !off.has('subagent')))
  );
}

/** 只增删内置工具组的名字，其余已激活工具（MCP、codemode 等）保持原序，减少声明变动 */
export function nextActiveToolNames(
  active: readonly string[],
  groups: ReadonlyMap<string, readonly string[]>,
  enabled: ReadonlySet<string>
): string[] {
  const off = new Set<string>();
  const on: string[] = [];
  for (const [id, names] of groups) {
    if (enabled.has(id)) on.push(...names);
    else for (const name of names) off.add(name);
  }
  const kept = active.filter((name) => !off.has(name));
  const present = new Set(kept);
  return [...kept, ...on.filter((name) => !present.has(name))];
}
