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
