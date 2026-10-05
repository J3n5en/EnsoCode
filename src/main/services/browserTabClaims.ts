/**
 * 共享浏览器的标签页操作锁（Main）：同一标签同一时刻只让一个成员会话操作。
 * 首次操作即占用，本轮结束 / 停止 / 闲置超时释放；被占时立即拒绝，不排队。
 * 用户本人不受锁限制，接管后占用者下一次操作收到提示。
 */
export interface BrowserActor {
  sessionId: string;
  name: string;
}

export type BrowserClaim = { ok: true; tookOver: boolean } | { ok: false; holder: BrowserActor };

interface Held {
  actor: BrowserActor;
  tookOver: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_IDLE_MS = 5 * 60_000;

export const browserTabBusyMessage = (name: string) =>
  `${name} is using this browser tab. Open a new tab (browser_navigate with newTab: true) or try again later.`;

export const BROWSER_TAKEOVER_NOTICE =
  'The user took over this browser tab since your last action, so the page may have changed. Call browser_snapshot to see the current page before continuing.';

export const BROWSER_TAB_CLOSED_NOTICE =
  'The browser tab you were using was closed. Call browser_navigate to open a page again.';

export class BrowserTabClaims {
  private readonly held = new Map<string, Held>();
  /** 成员会话正在用的标签；成员各用各的，不跟着别人切换 */
  private readonly pointers = new Map<string, string>();
  private readonly closed = new Set<string>();
  private readonly idleMs: number;
  private readonly onChange: (tabId: string) => void;

  constructor(options: { idleMs?: number; onChange?: (tabId: string) => void } = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.onChange = options.onChange ?? (() => {});
  }

  holder(tabId: string): BrowserActor | undefined {
    return this.held.get(tabId)?.actor;
  }

  pointer(sessionId: string): string | undefined {
    return this.pointers.get(sessionId);
  }

  point(sessionId: string, tabId: string): void {
    this.pointers.set(sessionId, tabId);
    this.closed.delete(sessionId);
  }

  claim(tabId: string, actor: BrowserActor): BrowserClaim {
    const current = this.held.get(tabId);
    if (current && current.actor.sessionId !== actor.sessionId)
      return { ok: false, holder: current.actor };
    if (current) clearTimeout(current.timer);
    const timer = setTimeout(() => this.drop(tabId), this.idleMs);
    (timer as { unref?: () => void }).unref?.();
    this.held.set(tabId, { actor, tookOver: false, timer });
    this.point(actor.sessionId, tabId);
    if (!current) this.onChange(tabId);
    return { ok: true, tookOver: current?.tookOver ?? false };
  }

  release(sessionId: string): void {
    for (const [tabId, entry] of [...this.held])
      if (entry.actor.sessionId === sessionId) this.drop(tabId);
  }

  forget(sessionId: string): void {
    this.release(sessionId);
    this.pointers.delete(sessionId);
    this.closed.delete(sessionId);
  }

  closeTab(tabId: string): void {
    this.drop(tabId);
    for (const [sessionId, pointed] of [...this.pointers])
      if (pointed === tabId) {
        this.pointers.delete(sessionId);
        this.closed.add(sessionId);
      }
  }

  /** 成员在用的标签被关掉后，下一次操作取一次提示 */
  takeClosed(sessionId: string): boolean {
    return this.closed.delete(sessionId);
  }

  userTookOver(tabId: string): void {
    const entry = this.held.get(tabId);
    if (entry) entry.tookOver = true;
  }

  private drop(tabId: string): void {
    const entry = this.held.get(tabId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.held.delete(tabId);
    this.onChange(tabId);
  }
}
