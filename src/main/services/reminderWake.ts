/** 根会话的自定提醒到点后 Main 怎么处理：删除 / 归档 / 已结束的清掉，活着的直接触发，冷会话先打开 */
export function planReminderWake(input: {
  row: Record<string, unknown> | null | undefined;
  alive: boolean;
  lifecycle?: string;
  /** 权威注册表里会话还在（settings 投影丢了也不算删除） */
  known?: boolean;
}): 'clear' | 'fire' | 'resume' {
  if (input.row?.archived === true || input.lifecycle === 'ended') return 'clear';
  if (!input.row && !input.known) return 'clear';
  return input.alive ? 'fire' : 'resume';
}

export interface ReminderResumeRequest {
  sessionId: string;
  providerId: string;
  modelId: string;
  cwd: string;
  resumeFile: string;
}

/**
 * settings 投影丢了会话行（强杀发生在防抖写盘之前）时，按权威注册表拼恢复请求：
 * 模型认注册表记的选择，会话文件认绑定，cwd 由调用方从项目权威记录推导。缺任何一项都不猜。
 */
export function reminderResumeFromAuthority(input: {
  sessionId: string;
  authority?: {
    lifecycle?: string;
    bot?: unknown;
    sessionFile?: string;
    selection?: { providerId?: string; modelId?: string };
  };
  cwd: string | null;
}): ReminderResumeRequest | null {
  const authority = input.authority;
  if (!authority || authority.lifecycle === 'ended' || authority.bot) return null;
  const { providerId, modelId } = authority.selection ?? {};
  if (!providerId || !modelId || !authority.sessionFile || !input.cwd) return null;
  return {
    sessionId: input.sessionId,
    providerId,
    modelId,
    cwd: input.cwd,
    resumeFile: authority.sessionFile,
  };
}
