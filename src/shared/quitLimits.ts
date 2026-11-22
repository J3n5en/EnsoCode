/**
 * 退出 / 安装更新前没有工具在跑（回复在写、重试倒计时）时等这一轮写完：保底内无条件等，之后最近
 * QUIT_REPLY_IDLE_MS 内还在出 token（含思考与工具参数增量）就顺延，最多等到 QUIT_REPLY_WAIT_CAP_MS。
 * 到点中止回复，worker 把这一轮记成续跑点、冷启动接着跑。Main 的等待与渲染层的等待弹层共用
 */
export const QUIT_REPLY_WAIT_FLOOR_MS = 60_000;
export const QUIT_REPLY_IDLE_MS = 20_000;
export const QUIT_REPLY_WAIT_CAP_MS = 180_000;

/** 回复等待到点的原因：保底后停止出 token 超过空闲阈值 / 到了总上限 */
export type ReplyWaitEnd = 'idle' | 'cap';

/** 从 waitStart（没有工具在跑起）算的回复等待截止时刻；lastOutputAt 是在写的会话里最近一次出 token */
export function replyWaitDeadline(
  waitStart: number,
  lastOutputAt: number | undefined
): { at: number; end: ReplyWaitEnd } {
  const cap = waitStart + QUIT_REPLY_WAIT_CAP_MS;
  const extended = Math.max(
    waitStart + QUIT_REPLY_WAIT_FLOOR_MS,
    lastOutputAt === undefined ? Number.NEGATIVE_INFINITY : lastOutputAt + QUIT_REPLY_IDLE_MS
  );
  return extended >= cap ? { at: cap, end: 'cap' } : { at: extended, end: 'idle' };
}
