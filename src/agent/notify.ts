/** 通知去抖窗口(多个子代理/任务同时完成时合并成一条) */
const DEBOUNCE_MS = 150;
/** 首条通知起的最长等待(去抖被持续续期时的硬顶) */
const MAX_WAIT_MS = 1000;

interface Buffer {
  texts: string[];
  debounce?: NodeJS.Timeout;
  maxWait?: NodeJS.Timeout;
}

/**
 * 父会话通知的合并投递(借鉴 pi-subagents completion-batcher):
 * 普通通知按 sessionId 去抖合并;紧急通知(失败/用户动作)先 flush 已积压的,再立即直投。
 */
export class ParentNotifier {
  private readonly buffers = new Map<string, Buffer>();

  constructor(private readonly deliver: (sessionId: string, text: string) => void) {}

  notify(sessionId: string, text: string, opts: { urgent?: boolean } = {}): void {
    if (opts.urgent) {
      this.flush(sessionId);
      this.deliver(sessionId, text);
      return;
    }
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = { texts: [] };
      this.buffers.set(sessionId, buffer);
    }
    buffer.texts.push(text);
    if (buffer.debounce) clearTimeout(buffer.debounce);
    buffer.debounce = setTimeout(() => this.flush(sessionId), DEBOUNCE_MS);
    buffer.maxWait ??= setTimeout(() => this.flush(sessionId), MAX_WAIT_MS);
  }

  flush(sessionId: string): void {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return;
    if (buffer.debounce) clearTimeout(buffer.debounce);
    if (buffer.maxWait) clearTimeout(buffer.maxWait);
    this.buffers.delete(sessionId);
    if (buffer.texts.length > 0) {
      this.deliver(sessionId, buffer.texts.join('\n\n---\n\n'));
    }
  }
}
