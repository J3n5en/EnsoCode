import { WORKSPACE_WRITE_TOOL_ID } from '../childProfileTools';
import { BUILTIN_TOOLS } from '../types/builtinTools';
import { SILENCE_TURN_TOOL } from './silence';

export const SECRETARY_OPS = [
  'project_list',
  'project_info',
  'repo_status',
  'session_list',
  'claims_list',
  'threads_list',
  'session_read',
  'session_tasks',
  'session_activity',
  'session_create',
  'session_send',
  'session_queue_list',
  'session_queue_cancel',
  'session_stop',
  'session_task_stop',
  'session_archive',
  'session_unarchive',
  'result_mark_done',
  'result_mark_undo',
  'needs_user_escalate',
  'session_answer',
  'session_takeover_propose',
  'image_view',
  'contact_send_file',
  'cleanup_list',
  'cleanup_apply',
  'todo_list',
  'todo_item_add',
  'todo_item_update',
  'todo_item_dispatch',
  'schedule_add',
  'schedule_list',
  'schedule_remove',
  'secretary_profile_propose',
  'skill_propose',
  'tool_propose',
  'secretary_list',
  'secretary_message',
] as const;

export type SecretaryOp = (typeof SECRETARY_OPS)[number];

/**
 * session_send 的投递方式：queue 排在目标会话当前回合之后（默认），
 * steer 在目标会话当前这次工具调用结束后立刻注入，不等整轮结束。
 */
export const SECRETARY_SEND_MODES = ['queue', 'steer'] as const;

export type SecretarySendMode = (typeof SECRETARY_SEND_MODES)[number];

/**
 * 模型看不见的内部 op：秘书自造工具的执行入口由 worker 按工具名逐个生成，
 * 参数里带工具名，所以它不能出现在模型可调用的工具表里。
 */
export const SECRETARY_INTERNAL_OPS = ['tool_run'] as const;

export type SecretaryInternalOp = (typeof SECRETARY_INTERNAL_OPS)[number];

export type SecretaryInvokeOp = SecretaryOp | SecretaryInternalOp;

/** 模型侧 schema 与 Main 校验共用的上限：两边各写一份会漂移 */
export const SECRETARY_ID_MAX = 200;
export const SECRETARY_SESSION_MESSAGE_MAX = 8000;
/** session_send 一次最多转发几张图；路径上限与 image_view 一致 */
export const SECRETARY_ATTACHMENT_MAX = 5;
export const SECRETARY_ATTACHMENT_PATH_MAX = 1024;
/** contact_send_file 的说明文字上限；超过渠道自己的 caption 上限时由渠道另发一条 */
export const SECRETARY_CONTACT_CAPTION_MAX = 2000;

/**
 * 秘书会话可见工具的唯一来源：worker 装配时按名字做允许列表，白名单外的一律不可见。
 * 新增内置工具不会自动进入秘书会话。
 */
export const SECRETARY_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  ...SECRETARY_OPS,
  // worker 本地只读工具：按 spawn 时实际加载的 skill 表读 SKILL.md，不碰任意路径
  'skill_read',
  'ask_user',
  SILENCE_TURN_TOOL,
  'web_search',
  'web_fetch',
  'memory_search',
  'memory_capture',
  'memory_crystallize',
  'memory_delete',
]);

/**
 * 插件工具与秘书自造工具的名字由 Main 在 spawn 时明确下发，worker 不按前缀放行：
 * 前缀能被任何名字伪造，只有本次真的装上的工具才算数。
 */
export function isSecretaryToolAllowed(
  name: string,
  extraToolNames?: ReadonlySet<string>
): boolean {
  return SECRETARY_TOOL_ALLOWLIST.has(name) || extraToolNames?.has(name) === true;
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
