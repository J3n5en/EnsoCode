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

/**
 * 回前台换链后 rpc-ready 或末尾几帧可能丢在半死的旧通道上：没有后续帧就不会出现 seq 缺口，
 * iframe 会一直等下去。链路静默足够久仍未就绪/仍有未决请求时重新 hello（宿主按 seq 补发、按 id 去重）。
 */
export function needsRehello(
  now: number,
  slot: { ready: boolean; helloAt: number; pendingAt?: number },
  lastInbound: number
): boolean {
  if (!slot.ready) return stallDelay(now, HELLO_RETRY_MS, slot.helloAt, lastInbound) === 0;
  if (slot.pendingAt === undefined) return false;
  return stallDelay(now, PENDING_STALL_MS, slot.pendingAt, slot.helloAt, lastInbound) === 0;
}
