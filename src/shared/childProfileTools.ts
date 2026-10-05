import { parseWindowsLocalShell } from './windowsLocalShell';

export type ChildProfileShell = 'bash' | 'powershell';

/** 父会话 disabledTools 里的伪 id：命中时不挂 shell 与文件写工具（与 readonly 子代理同档） */
export const WORKSPACE_WRITE_TOOL_ID = 'workspace_write';

export interface ChildProfileToolOptions {
  /** 缺省 apply_patch：只挂 apply_patch，不挂 edit/write */
  editMode?: 'replace' | 'apply_patch';
  /** 缺省 bash。调用方应按平台 / 远程 / Windows shell 偏好传入 */
  shell?: ChildProfileShell;
  exploreFold?: boolean;
  /** 缺省开启，与「disabledBuiltinTools 不含 isolated_sandbox」一致 */
  isolatedSandbox?: boolean;
  workspaceWrite?: boolean;
}

/**
 * 普通 typed child 实际会挂上的工具名（不含 MCP）。
 * Main 的 exact profile proof 与 worker 装配必须共用这份推导。
 */
export function childProfileToolIds(
  tools: 'all' | 'readonly',
  options: ChildProfileToolOptions = {}
): readonly string[] {
  const editMode = options.editMode ?? 'apply_patch';
  const shell = options.shell ?? 'bash';
  const ids = ['read', 'grep', 'find', 'ls'];
  if (tools === 'all' && options.workspaceWrite !== false) {
    ids.push(shell);
    if (editMode === 'apply_patch') ids.push('apply_patch');
    else ids.push('edit', 'write');
  }
  ids.push('message_main_agent', 'message_coworker');
  if (options.exploreFold) ids.push('explore_mark', 'explore_fold');
  if (options.isolatedSandbox !== false) ids.push('codemode');
  return ids;
}

/** 与 worker createSessionCommandTool 的 shell 选择一致。 */
export function childProfileShell(input: {
  platform: string;
  remote?: boolean;
  preference?: unknown;
}): ChildProfileShell {
  if (input.remote) return 'bash';
  if (input.platform !== 'win32') return 'bash';
  return parseWindowsLocalShell(input.preference) === 'bash' ? 'bash' : 'powershell';
}
