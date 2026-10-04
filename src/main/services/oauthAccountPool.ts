import type { OauthPoolFailure } from '@shared/oauthAccountPool';

export const OAUTH_POOL_EXHAUSTED =
  'No available ChatGPT OAuth accounts in the sequential pool. Re-authenticate an account or wait for its quota reset.';

/**
 * Main 的进程级游标和额度窗口。成员由调用方实时校验；并发旧账号故障只封锁该账号，不推进新账号。
 *
 * Main owns process-wide cursors and quota windows. Callers validate membership live; concurrent stale failures block only the failed account, never advance its successor.
 */
export class OauthAccountPool {
  private readonly current = new Map<string, string>();
  private readonly blocked = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  select(
    poolId: string,
    orderedKeys: readonly string[],
    eligibleKeys: readonly string[],
    failed?: OauthPoolFailure
  ): string | undefined {
    const now = this.now();
    for (const [key, resetAt] of this.blocked) if (resetAt <= now) this.blocked.delete(key);
    if (failed && orderedKeys.includes(failed.accountKey)) {
      // 无 reset 证据只作短暂冷却；不把暂时故障持久化为永久不可用。
      //
      // Without reset evidence use a bounded cooldown, never persist a permanent failure.
      const until =
        failed.resetAt && failed.resetAt > now
          ? Math.min(failed.resetAt, now + 30 * 86_400_000)
          : now + 300_000;
      this.blocked.set(
        failed.accountKey,
        Math.max(this.blocked.get(failed.accountKey) ?? 0, until)
      );
    }
    const previous = this.current.get(poolId);
    const start = Math.max(0, orderedKeys.indexOf(previous ?? ''));
    const ordered = [...orderedKeys.slice(start), ...orderedKeys.slice(0, start)];
    const selected = ordered.find((key) => eligibleKeys.includes(key) && !this.blocked.has(key));
    if (selected) this.current.set(poolId, selected);
    return selected;
  }
}
