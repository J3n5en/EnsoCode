/** 根会话的自定提醒到点后 Main 怎么处理：删除 / 归档 / 已结束的清掉，活着的直接触发，冷会话先打开 */
export function planReminderWake(input: {
  row: Record<string, unknown> | null | undefined;
  alive: boolean;
  lifecycle?: string;
}): 'clear' | 'fire' | 'resume' {
  if (!input.row || input.row.archived === true || input.lifecycle === 'ended') return 'clear';
  return input.alive ? 'fire' : 'resume';
}
