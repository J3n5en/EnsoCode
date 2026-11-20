/**
 * 距判定「卡住」还要等多久，0 表示已卡住。
 * 中继下行可能只有几百 KB/s，大帧要传十几秒；只要还在收数据就不算丢，
 * 否则补发/重新 hello 会让宿主把同一批帧再排一遍队，越补越慢。
 */
export function stallDelay(now: number, windowMs: number, ...activity: number[]): number {
  return Math.max(0, Math.max(...activity) + windowMs - now);
}

const HELLO_RETRY_MS = 5_000;
const PENDING_STALL_MS = 20_000;
/** 未决请求最长等这么久：大帧不断（或别的事件刷屏）时静默永远等不到 */
const PENDING_MAX_MS = 60_000;
/** 大帧走中继、小帧走直连会乱序；缺口期间这么久没收到大帧视为丢帧 */
const GAP_RESYNC_MS = 8_000;
const GAP_MAX_MS = 20_000;
/**
 * 链路切换（换中继 socket、直连与中继互切、两端防重放重新握手）前后几秒最容易丢帧：
 * 这期间的缺口与挂起请求很快补，不按大帧在途的长窗口等。
 */
const LINK_SETTLE_MS = 5_000;
const LINK_GAP_RESYNC_MS = 1_500;
const LINK_PENDING_STALL_MS = 3_000;

const nearLink = (at: number, linkAt: number) => Math.abs(at - linkAt) <= LINK_SETTLE_MS;

/** 缺口距判丢帧还要等多久：看大帧是否还在传，但总等待有上限 */
export function gapResyncDelay(
  now: number,
  since: number,
  lastBulk: number,
  linkAt = Number.NEGATIVE_INFINITY
): number {
  const delay = Math.min(
    stallDelay(now, GAP_RESYNC_MS, since, lastBulk),
    stallDelay(now, GAP_MAX_MS, since)
  );
  if (!nearLink(since, linkAt)) return delay;
  return Math.min(delay, stallDelay(now, LINK_GAP_RESYNC_MS, since, lastBulk));
}

/**
 * 回前台换链后 rpc-ready 或末尾几帧可能丢在半死的旧通道上：没有后续帧就不会出现 seq 缺口，
 * iframe 会一直等下去。大帧静默足够久仍未就绪/仍有未决请求时重新 hello（宿主按 seq 补发、按 id 去重）。
 * 小帧不算进度：它们可能正是缺口之后、无法应用的帧。
 */
export function needsRehello(
  now: number,
  slot: { ready: boolean; helloAt: number; pendingAt?: number },
  lastBulk: number,
  linkAt = Number.NEGATIVE_INFINITY
): boolean {
  if (!slot.ready) return stallDelay(now, HELLO_RETRY_MS, slot.helloAt, lastBulk) === 0;
  if (slot.pendingAt === undefined) return false;
  if (
    nearLink(slot.pendingAt, linkAt) &&
    now - linkAt <= 2 * LINK_SETTLE_MS &&
    stallDelay(now, LINK_PENDING_STALL_MS, slot.pendingAt, slot.helloAt, lastBulk) === 0
  )
    return true;
  return (
    stallDelay(now, PENDING_STALL_MS, slot.pendingAt, slot.helloAt, lastBulk) === 0 ||
    stallDelay(now, PENDING_MAX_MS, slot.pendingAt, slot.helloAt) === 0
  );
}
