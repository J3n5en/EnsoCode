/**
 * 前台显式 timeout 达到让位时长时，agent 插在命令输出最前面的提醒。
 * 给模型看的；失败卡片标题要跳过它，显示真实报错。
 */
export const SHELL_TIMEOUT_HINT =
  'timeout only kills the process; it does not keep this call in the foreground. ' +
  'If the command may outlast the yield, set background: true and end your turn — completion wakes you. ' +
  'Do not poll with sleep, ps, pgrep, or task_output loops.';

/** 去掉开头的 timeout 提醒及紧随的空行；没有提醒或提醒后为空时原样返回 */
export function skipShellTimeoutHint(text: string): string {
  if (!text.startsWith(SHELL_TIMEOUT_HINT)) return text;
  const rest = text.slice(SHELL_TIMEOUT_HINT.length).replace(/^(?:\r?\n)+/, '');
  return rest || text;
}
