import { WORKSPACE_WRITE_TOOL_ID } from '../childProfileTools';
import { BUILTIN_TOOLS } from '../types/builtinTools';

export const SECRETARY_OPS = [
  'project_list',
  'project_info',
  'session_list',
  'session_read',
  'session_create',
  'session_send',
  'session_stop',
  'todo_item_add',
  'todo_item_update',
  'todo_item_dispatch',
  'schedule_add',
  'schedule_list',
  'schedule_remove',
  'secretary_profile_propose',
  'skill_propose',
] as const;

export type SecretaryOp = (typeof SECRETARY_OPS)[number];

/**
 * 秘书会话可见工具的唯一来源：worker 装配时按名字做允许列表，白名单外的一律不可见。
 * 新增内置工具不会自动进入秘书会话。
 */
export const SECRETARY_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  ...SECRETARY_OPS,
  // worker 本地只读工具：按 spawn 时实际加载的 skill 表读 SKILL.md，不碰任意路径
  'skill_read',
  'ask_user',
  'web_search',
  'web_fetch',
  'memory_search',
  'memory_capture',
  'memory_crystallize',
  'memory_delete',
]);

/**
 * 插件工具名由 Main 在 spawn 时明确下发，worker 不按 `plugin_` 前缀放行：
 * 前缀能被任何名字伪造，只有本次真的装上的工具才算数。
 */
export function isSecretaryToolAllowed(
  name: string,
  pluginToolNames?: ReadonlySet<string>
): boolean {
  return SECRETARY_TOOL_ALLOWLIST.has(name) || pluginToolNames?.has(name) === true;
}

/** 白名单覆盖到的内置工具分组；其余分组对秘书一律关闭，含 codemode 所在的 isolated_sandbox */
const ALLOWED_BUILTIN_GROUPS: ReadonlySet<string> = new Set(['ask_user', 'web', 'memory']);

/** Main 下发给秘书会话的强制禁用列表：白名单外的全部分组，加上不走分组的 workspace_write 与 goal */
export const SECRETARY_FORCED_DISABLED_TOOLS: readonly string[] = [
  ...BUILTIN_TOOLS.map((tool) => tool.id).filter((id) => !ALLOWED_BUILTIN_GROUPS.has(id)),
  WORKSPACE_WRITE_TOOL_ID,
  'goal',
];

/** 记忆是秘书的核心能力：全局"禁用内置工具"对秘书会话不生效（默认关 memory，秘书始终开着） */
export const SECRETARY_ALWAYS_ENABLED_TOOLS: readonly string[] = ['memory'];
