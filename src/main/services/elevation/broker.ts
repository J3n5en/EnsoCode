import { randomUUID } from 'node:crypto';
import {
  ELEVATE_TIMEOUT_MS,
  type ElevationOutcome,
  type ElevationRequestView,
} from '@shared/elevation';

export interface ElevationBrokerDeps {
  /** 此刻有没有能输入口令的界面（桌面窗口或完整模式的远程主界面） */
  canPresent: () => boolean;
  changed: (views: ElevationRequestView[]) => void;
  timeoutMs?: number;
  now?: () => number;
}

interface Entry {
  view: ElevationRequestView;
  sudoPid: number;
  helperPid: number;
  settle: (outcome: ElevationOutcome) => void;
}

/** 待批提权请求：谁先应答谁生效，超时或连接断开即作废 */
export class ElevationBroker {
  private readonly pending = new Map<string, Entry>();
  /** sudo pid → 上次交出口令的时刻；同一 sudo 再来要说明口令错了 */
  private readonly answered = new Map<number, number>();

  constructor(private readonly deps: ElevationBrokerDeps) {}

  private get timeoutMs(): number {
    return this.deps.timeoutMs ?? ELEVATE_TIMEOUT_MS;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  request(input: { command: string; sudoPid: number; helperPid: number }): {
    id: string | null;
    outcome: Promise<ElevationOutcome>;
  } {
    // 同一进程重复来要：有人冒用，两边都作废
    const clash = [...this.pending.values()].find(
      (entry) => entry.sudoPid === input.sudoPid || entry.helperPid === input.helperPid
    );
    if (clash) {
      clash.settle({ kind: 'declined' });
      return { id: null, outcome: Promise.resolve({ kind: 'declined' }) };
    }
    if (!this.deps.canPresent()) {
      return { id: null, outcome: Promise.resolve({ kind: 'unavailable' }) };
    }
    const now = this.now();
    for (const [pid, at] of this.answered) {
      if (now - at > this.timeoutMs) this.answered.delete(pid);
    }
    const id = randomUUID();
    const view: ElevationRequestView = {
      id,
      command: input.command,
      retry: this.answered.has(input.sudoPid),
      expiresAt: now + this.timeoutMs,
    };
    const outcome = new Promise<ElevationOutcome>((resolve) => {
      const timer = setTimeout(() => entry.settle({ kind: 'timeout' }), this.timeoutMs);
      const entry: Entry = {
        view,
        sudoPid: input.sudoPid,
        helperPid: input.helperPid,
        settle: (result) => {
          if (this.pending.get(id) !== entry) return;
          clearTimeout(timer);
          this.pending.delete(id);
          if (result.kind === 'password') this.answered.set(input.sudoPid, this.now());
          resolve(result);
          this.deps.changed(this.list());
        },
      };
      this.pending.set(id, entry);
    });
    this.deps.changed(this.list());
    return { id, outcome };
  }

  /** password 为 null 表示拒绝；请求已不在（超时/被别处应答）返回 false */
  answer(id: string, password: string | null): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.settle(password === null ? { kind: 'declined' } : { kind: 'password', password });
    return true;
  }

  /** sudo 已退出（命令被中止） */
  cancel(id: string): void {
    this.pending.get(id)?.settle({ kind: 'declined' });
  }

  declineAll(): void {
    for (const entry of [...this.pending.values()]) entry.settle({ kind: 'declined' });
  }

  list(): ElevationRequestView[] {
    return [...this.pending.values()].map((entry) => entry.view);
  }
}
