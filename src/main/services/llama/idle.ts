import { normalizeMemoryModelIdleMinutes } from '@shared/memory/modelIdle';

/** 只计资源空闲时间；排队前 acquire，底层工作真正结束后 release。 */
export class ModelIdleTimer {
  private minutes = 10;
  private pending = 0;
  private idleSince: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly unload: () => Promise<void>) {}

  configure(value: unknown): void {
    const minutes = normalizeMemoryModelIdleMinutes(value);
    if (minutes === this.minutes) return;
    this.minutes = minutes;
    this.arm();
  }

  acquire(): () => void {
    this.pending++;
    this.clear();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.pending === 0) this.touch();
    };
  }

  touch(): void {
    this.idleSince = Date.now();
    this.arm();
  }

  reset(): void {
    this.clear();
    this.idleSince = null;
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.clear();
    if (this.pending || this.minutes === 0 || this.idleSince === null) return;
    const remaining = this.minutes * 60_000 - (Date.now() - this.idleSince);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.idleSince = null;
        void this.unload().catch(() => {});
      },
      Math.max(0, remaining)
    );
    this.timer.unref?.();
  }
}
