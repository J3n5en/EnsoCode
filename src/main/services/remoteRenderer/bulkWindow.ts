/**
 * 远程桌面大帧的发送窗口：浏览器回报已收字节，宿主只让一个窗口的未确认数据在路上。
 *
 * 桌面上行可能只有几百 KB/s，一次把 MB 级分片全写进 socket 会堆在系统 TCP 缓冲里（bufferedAmount 看不到），
 * 心跳 ping 排在后面超时、中继被判死重连，在途数据全丢再补发，越补越慢。
 * 旧版浏览器不回报，收到第一次 ack 之前不限流。
 */
export class BulkWindow<T> {
  private enabled = false;
  private inflight = 0;
  private acked = 0;
  private lastProgressAt = 0;
  private queue: { item: T; bytes: number; group?: string }[] = [];
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly windowBytes: number;
  private readonly stallMs: number;

  constructor(
    private readonly send: (item: T) => void,
    options: { windowBytes?: number; stallMs?: number } = {}
  ) {
    this.windowBytes = options.windowBytes ?? 512 * 1024;
    this.stallMs = options.stallMs ?? 15_000;
  }

  push(item: T, bytes: number, group?: string): void {
    if (!this.enabled) {
      this.send(item);
      return;
    }
    this.queue.push({ item, bytes, group });
    this.pump();
  }

  /** 同一逻辑帧补发前清掉队里尚未发出的旧分片，避免重发堆积或新旧分片混用 id */
  dropGroup(group: string): void {
    if (this.queue.length === 0) return;
    this.queue = this.queue.filter((entry) => entry.group !== group);
    if (this.queue.length === 0) this.clearStall();
  }

  /** slot 重同步或关闭时，清掉队里尚未发出的该 slot 旧分片，避免解锁后抢占窗口 */
  dropPrefix(prefix: string): void {
    if (this.queue.length === 0) return;
    this.queue = this.queue.filter((entry) => !entry.group?.startsWith(prefix));
    if (this.queue.length === 0) this.clearStall();
  }

  /** bytes：浏览器本页累计收到的分片字节；比上次小说明换了新页面 */
  ack(bytes: number): void {
    this.enabled = true;
    const delta = bytes >= this.acked ? bytes - this.acked : bytes;
    this.acked = bytes;
    if (delta > 0) {
      this.lastProgressAt = Date.now();
      this.inflight = Math.max(0, this.inflight - delta);
      this.clearStall();
    }
    this.pump();
  }

  /**
   * 浏览器发 rpc-hello 催补发时，若窗口已满且这段时间没有真正收到新字节，说明在途分片已丢，
   * 立即释放窗口而不是硬等 stallMs；正在正常收数据时不打断。
   */
  unblock(minStaleMs = 2_000): void {
    if (!this.enabled || this.inflight === 0) return;
    if (Date.now() - this.lastProgressAt < minStaleMs) return;
    this.inflight = 0;
    this.clearStall();
    this.pump();
  }

  /** 链路断开：已排队的不再发（续上后宿主按 seq 补发，资源由浏览器重新请求） */
  reset(): void {
    this.queue = [];
    this.inflight = 0;
    this.lastProgressAt = 0;
    this.clearStall();
  }

  private pump(): void {
    while (this.queue.length > 0 && this.inflight < this.windowBytes) {
      const next = this.queue.shift() as { item: T; bytes: number; group?: string };
      this.lastProgressAt = Date.now();
      this.inflight += next.bytes;
      this.send(next.item);
    }
    if (this.queue.length > 0 && !this.stallTimer) {
      // ack 丢了也别永远卡住：一段时间没回报就当已送达
      this.stallTimer = setTimeout(() => {
        this.stallTimer = null;
        this.inflight = 0;
        this.pump();
      }, this.stallMs);
    }
  }

  private clearStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }
}
