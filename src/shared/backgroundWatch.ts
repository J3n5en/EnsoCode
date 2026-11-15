// 派出会话空闲等后台任务时的看门狗判定。
// 正常完成通知会自己开一轮；这里只处理超时、进程已死、完成了却没把会话唤醒。

export const BACKGROUND_WAKE_GRACE_MS = 2_000;

export type BackgroundWatchReason = 'timeout' | 'dead' | 'undelivered';

export interface BackgroundStall {
  conversationId: string;
  taskId: string;
  reason: BackgroundWatchReason;
}

/** 回传给秘书的一句原因，接在原有 stalled 文案后面 */
export const BACKGROUND_STALL_DETAIL: Record<BackgroundWatchReason, string> = {
  timeout: '后台任务已超时',
  dead: '后台进程已退出',
  undelivered: '后台任务已完成但没有唤醒',
};

const WAKE_REASON: Record<BackgroundWatchReason, string> = {
  timeout: 'It reached its timeout while this session was idle.',
  dead: 'Its process is gone.',
  undelivered: 'It finished, but the completion notification was not delivered.',
};

export function backgroundWakeText(reason: BackgroundWatchReason, taskId: string): string {
  return [
    '<background-task-watchdog>',
    `Background task ${taskId} did not wake this session. ${WAKE_REASON[reason]}`,
    'Do not wait for it again. Continue the task, or report what is blocked.',
    '</background-task-watchdog>',
  ].join('\n');
}

export interface WatchedBackgroundTask {
  taskId: string;
  status: 'running' | 'done' | 'failed';
  /** 截止已到时任务还在跑 */
  overdue?: boolean;
  deadlineAt?: number;
  /** 还在等的时候进程已经不在；未探测（alive 缺省）不算，按未知处理 */
  dead?: boolean;
  /** 第一次确认进程已死的时刻；宽限从这里算，不能用调用时的 now */
  deadAt?: number;
  endedAt?: number;
}

/**
 * 这一轮已经停下来等后台任务。
 * 超时 / 进程已死：即使完成通知后来把会话叫醒，也要告诉秘书。
 * 完成未唤醒：宽限期内会话又跑起来，就当通知送到了，不报。
 * wake 为真时调用方才去 prompt；宽限用来躲开 worker 正在投递的那条完成通知。
 */
export function backgroundWaitStall(
  input: {
    awaiting: boolean;
    idle: boolean;
    pendingUser: boolean;
    /** 失败出现之后又跑完了一轮：worker 已经叫醒过，不要再 prompt */
    consumed?: boolean;
    tasks: readonly WatchedBackgroundTask[];
  },
  now: number
): { taskId: string; reason: BackgroundWatchReason; wake: boolean } | null {
  if (!input.awaiting || input.pendingUser) return null;
  // 还在跑的任务才是会话在等的东西。进程已死只对它们成立：已结束的（exited / killed）
  // 算退出，由下面「完成没唤醒」那条处理；拿一条早就结束的任务去报还在等别的任务的会话，
  // 就是误报。
  const running = input.tasks.filter((task) => task.status === 'running');
  const dead = running.find((task) => task.dead);
  // 超时不看任务是否已收口（到点被杀也要告诉秘书），但会话还在等别的任务时不拿旧任务报
  const overdue = (running.length > 0 ? running : input.tasks).find((task) => task.overdue);
  const failure = overdue
    ? { taskId: overdue.taskId, reason: 'timeout' as const, at: overdue.deadlineAt ?? now }
    : dead
      ? { taskId: dead.taskId, reason: 'dead' as const, at: dead.deadAt ?? now }
      : null;
  if (failure) {
    return {
      taskId: failure.taskId,
      reason: failure.reason,
      wake: input.idle && !input.consumed && now - failure.at >= BACKGROUND_WAKE_GRACE_MS,
    };
  }
  if (!input.idle || input.consumed) return null;
  // 还有任务在跑：等它自己的完成通知，别把已经结束的那条当成没唤醒
  if (running.length > 0) return null;
  const ended = input.tasks.filter((task) => task.endedAt !== undefined);
  if (ended.length === 0) return null;
  const oldest = ended.reduce((left, right) =>
    (left.endedAt ?? now) <= (right.endedAt ?? now) ? left : right
  );
  const endedAt = oldest.endedAt ?? now;
  if (now - endedAt < BACKGROUND_WAKE_GRACE_MS) return null;
  return { taskId: oldest.taskId, reason: 'undelivered', wake: true };
}
