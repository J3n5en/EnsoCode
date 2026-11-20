/**
 * agent 插在 shell 命令输出最前面的提醒（每条一行，之后空一行再接输出）。
 * 给模型看的；失败卡片标题要跳过它们，显示真实报错。
 */
export const SHELL_READ_HINT =
  'Shell read-only shortcut: prefer read (offset/limit) for files, grep for content, ' +
  'find for paths — the dedicated tools handle line ranges and stream far less output.';

export const SHELL_SLEEP_HINT =
  'Sleep-waiting in a foreground command costs a model round per check. Put the whole wait in one ' +
  'command that exits when the condition holds (e.g. `until <check>; do sleep 10; done; <report>`) ' +
  'and run it with background: true — you are notified when it finishes, then end your turn.';

/** 前台显式 timeout 达到让位时长、且命令跑得久或已转后台时的提醒 */
export const SHELL_TIMEOUT_HINT =
  'timeout only kills the process; it does not keep this call in the foreground. ' +
  'If the command may outlast the yield, set background: true and end your turn — completion wakes you. ' +
  'Do not poll with sleep, ps, pgrep, or task_output loops.';

const SHELL_HINTS = new Set([SHELL_READ_HINT, SHELL_SLEEP_HINT, SHELL_TIMEOUT_HINT]);

/** 去掉开头连续的提醒行及紧随的空行；没有提醒或提醒后为空时原样返回 */
export function skipShellHints(text: string): string {
  const lines = text.split('\n');
  let at = 0;
  while (at < lines.length && SHELL_HINTS.has(lines[at].replace(/\r$/, ''))) at++;
  if (at === 0) return text;
  while (at < lines.length && !lines[at].trim()) at++;
  return lines.slice(at).join('\n') || text;
}

/** pi 与前台包装写在输出末尾的命令结局 */
const EXIT_STATUS = /^Command exited with code \d+$/;
const END_STATUS =
  /^Command (?:aborted|timed out after \d+ seconds|terminated without an exit code)/;
/** 输出末尾的附注：失败分类、截断说明、rtk 召回 */
const ANNOTATION = /^\[[^\]]+\]/;
const STACK_FRAME = /^at\s/;
const ERROR_LINE =
  /\b(?:error|fatal|panic|exception|failed|failure|cannot|not found|no such file|denied|refused)\b(?!\.\w|\()/i;

/**
 * 失败命令卡片的标题。退出码非 0 时取退出状态前最后一条像报错的行（错误多在末尾，
 * 开头常是前面成功命令的输出）；找不到就用退出状态本身。超时/中断以状态行为准。
 */
export function shellFailureHeadline(output: string): string {
  const lines = skipShellHints(output)
    .split(/\r?\n/)
    .map((line) => line.trim());
  const status = lines.findLastIndex((line) => EXIT_STATUS.test(line) || END_STATUS.test(line));
  if (status < 0) return lines.find(Boolean) ?? '';
  if (END_STATUS.test(lines[status])) return lines[status];
  for (let index = status - 1; index >= 0; index--) {
    const line = lines[index];
    if (line && !ANNOTATION.test(line) && !STACK_FRAME.test(line) && ERROR_LINE.test(line)) {
      return line;
    }
  }
  return lines[status];
}
