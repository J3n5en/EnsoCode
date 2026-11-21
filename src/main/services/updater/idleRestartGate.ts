import {
  type AutoRestartIdleSnapshot,
  type AutoRestartMode,
  idleDurationMs,
  isAutoRestartBlocked,
  nextIdleSince,
  remainingIdleMs,
  shouldAutoRestartForUpdate,
} from '@shared/updater/idleRestart';

export type IdleRestartObservation = Omit<AutoRestartIdleSnapshot, 'idleForMs' | 'mode'>;

/** 跟踪连续空闲；quitAndInstall 失败后不再自动重试。 */
export class IdleRestartGate {
  private idleSince: number | null = null;
  private failed = false;

  evaluate(observation: IdleRestartObservation, mode: AutoRestartMode, now: number): boolean {
    if (this.failed) return false;
    const snapshot = { ...observation, mode };
    this.idleSince = nextIdleSince(this.idleSince, isAutoRestartBlocked(snapshot), now);
    return shouldAutoRestartForUpdate({
      ...snapshot,
      idleForMs: idleDurationMs(this.idleSince, now),
    });
  }

  markFailed(): void {
    this.failed = true;
    this.idleSince = null;
  }

  reset(): void {
    this.idleSince = null;
    this.failed = false;
  }

  delayUntilReadyMs(now: number): number | null {
    if (this.failed) return null;
    return remainingIdleMs(this.idleSince, now);
  }

  isFailed(): boolean {
    return this.failed;
  }
}
