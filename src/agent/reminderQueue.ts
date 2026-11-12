/** 待投递完成通知的容量上限：防无界增长；溢出是显式的丢，队首留告知让模型知道有结果没送到 */
export const REMINDER_QUEUE_LIMIT = 1000;

const OVERFLOW_NOTICE = /^\[Queue overflow\] (\d+) /;

function overflowNotice(dropped: number): string {
  return (
    `[Queue overflow] ${dropped} earlier background notifications were dropped before delivery. ` +
    'The tasks were not stopped; check their current state (task_output, subagent list/report) before relying on them.'
  );
}

/** 入队；满了丢最旧的（队首溢出告知累加计数、不计入驱逐）并返回 true */
export function enqueueReminder(
  queue: string[],
  text: string,
  limit = REMINDER_QUEUE_LIMIT
): boolean {
  queue.push(text);
  if (queue.length <= limit) return false;
  const prior = OVERFLOW_NOTICE.exec(queue[0] ?? '');
  if (prior) queue.shift();
  const excess = queue.length - (limit - 1);
  queue.splice(0, excess);
  queue.unshift(overflowNotice(excess + (prior ? Number(prior[1]) : 0)));
  return true;
}
