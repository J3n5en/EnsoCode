import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isCodexAccountKey, type OauthPoolFailure } from '@shared/oauthAccountPool';
import type { OauthAccountUsage, OauthUsageWindow } from '@shared/types';
import { OAUTH_POOL_EXHAUSTED } from './oauthAccountPool';

const TTL = 60_000;
const ERROR_TTL = 15_000;
const SELECTION_QUERY_BUDGET = 20_000;
const MAX_WINDOW = 30 * 86_400_000;
const MAX_FILE_BYTES = 256 * 1024;
const RECEIPT_TTL = 24 * 3_600_000;
const MAX_RECEIPTS = 4096;

interface Evidence {
  identity: string;
  checkedAt: number;
  windows: Array<Pick<OauthUsageWindow, 'usedPercent' | 'resetsAt'>>;
  hardUntil?: number;
}
interface CachedUsage {
  identity: string;
  value: OauthAccountUsage;
  expiresAt: number;
  checkedAt: number;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const validTime = (value: unknown, now: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now + MAX_WINDOW;
const validIdentity = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validWindows(value: unknown, now: number): OauthUsageWindow[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return undefined;
  const result: OauthUsageWindow[] = [];
  for (const raw of value) {
    const window = object(raw);
    if (
      !window ||
      typeof window.usedPercent !== 'number' ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100 ||
      (window.resetsAt !== undefined && !validTime(window.resetsAt, now))
    )
      return undefined;
    // 过期窗口不是恢复证据；必须向上游重新确认。
    //
    // An expired window is not recovery evidence; confirmation must come from upstream.
    if (typeof window.resetsAt === 'number' && window.resetsAt <= now) return undefined;
    result.push({
      label: typeof window.label === 'string' ? window.label.slice(0, 100) : '',
      usedPercent: window.usedPercent,
      ...(typeof window.resetsAt === 'number' ? { resetsAt: window.resetsAt } : {}),
    });
  }
  return result;
}

export interface OauthQuotaDependencies {
  now?: () => number;
  file: string;
  identity: (key: string) => Promise<string | undefined>;
  query: (key: string) => Promise<OauthAccountUsage>;
}

/**
 * Main 的唯一额度权威：只在候选证据未知、过期或 reset 到期时查额度，绝不用模型请求探测已知耗尽账号。
 * 本地 sidecar 只存账号 key、身份摘要、有限额度窗口及硬失败截止时间；同步原子写避免并发快照倒序覆盖。
 *
 * Main's quota authority queries only unknown/stale candidates or expired resets, never probes known exhausted accounts with model requests.
 * The local sidecar contains only account keys, identity digests, bounded windows and hard-failure deadlines; synchronous atomic writes prevent out-of-order snapshots.
 */
export class OauthQuotaCoordinator {
  private readonly now: () => number;
  private readonly current = new Map<string, string>();
  private readonly evidence = new Map<string, Evidence>();
  private readonly cache = new Map<string, CachedUsage>();
  private readonly inFlight = new Map<
    string,
    { identity: string; promise: Promise<OauthAccountUsage> }
  >();
  private readonly generations = new Map<string, number>();
  private readonly credentialGenerations = new Map<string, number>();
  private readonly receipts = new Map<
    string,
    { poolId: string; key: string; identity: string; generation: number; issuedAt: number }
  >();

  constructor(private readonly deps: OauthQuotaDependencies) {
    this.now = deps.now ?? Date.now;
    this.load();
  }

  private load(): void {
    try {
      if (statSync(this.deps.file).size > MAX_FILE_BYTES) return;
      const parsed = object(JSON.parse(readFileSync(this.deps.file, 'utf8')) as unknown);
      if (parsed?.version !== 1 || !Array.isArray(parsed.records) || parsed.records.length > 1000)
        return;
      const now = this.now();
      for (const raw of parsed.records) {
        const record = object(raw);
        if (
          !record ||
          !isCodexAccountKey(record.key) ||
          record.key.length > 100 ||
          !validIdentity(record.identity) ||
          !validTime(record.checkedAt, now) ||
          record.checkedAt > now ||
          record.checkedAt < now - MAX_WINDOW ||
          !Array.isArray(record.windows) ||
          record.windows.length > 20 ||
          (record.hardUntil !== undefined &&
            (!validTime(record.hardUntil, now) || record.hardUntil > record.checkedAt + MAX_WINDOW))
        )
          continue;
        const windows: Evidence['windows'] = [];
        let invalid = false;
        for (const rawWindow of record.windows) {
          const window = object(rawWindow);
          if (
            window?.usedPercent !== 100 ||
            !validTime(window.resetsAt, now) ||
            window.resetsAt > record.checkedAt + MAX_WINDOW
          ) {
            invalid = true;
            break;
          }
          windows.push({ usedPercent: 100, resetsAt: window.resetsAt });
        }
        if (invalid) continue;
        this.evidence.set(record.key, {
          identity: record.identity,
          checkedAt: record.checkedAt,
          windows,
          ...(typeof record.hardUntil === 'number' ? { hardUntil: record.hardUntil } : {}),
        });
      }
    } catch {
      // 缓存缺失或损坏时重新查额度，不能把坏数据解释为耗尽。
      //
      // Missing/corrupt cache triggers a fresh query, never an exhaustion inference.
    }
  }

  private save(): void {
    const now = this.now();
    const records = [...this.evidence].flatMap(([key, record]) => {
      const windows = record.windows.filter(
        (window) => window.usedPercent >= 100 && (window.resetsAt ?? 0) > now
      );
      const hardUntil = record.hardUntil && record.hardUntil > now ? record.hardUntil : undefined;
      return windows.length || hardUntil
        ? [
            {
              key,
              identity: record.identity,
              checkedAt: record.checkedAt,
              windows,
              ...(hardUntil ? { hardUntil } : {}),
            },
          ]
        : [];
    });
    try {
      const tmp = `${this.deps.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, records }), {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(tmp, this.deps.file);
    } catch {
      console.warn('[OAuthQuota] Could not persist local quota evidence');
    }
  }

  invalidate(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.credentialGenerations.set(key, (this.credentialGenerations.get(key) ?? 0) + 1);
    for (const [receipt, record] of this.receipts)
      if (record.key === key) this.receipts.delete(receipt);
    this.evidence.delete(key);
    this.cache.delete(key);
    this.inFlight.delete(key);
    for (const [pool, current] of this.current) if (current === key) this.current.delete(pool);
    this.save();
  }

  /**
   * 按真实凭证集合清理外部删除的账号；不按池配置清理，因为多个池共享账号证据。
   *
   * Prune externally deleted credentials using the authoritative credential set, not pool membership, since pools share evidence.
   */
  reconcileKeys(keys: ReadonlySet<string>): void {
    for (const key of new Set([
      ...this.evidence.keys(),
      ...this.cache.keys(),
      ...this.inFlight.keys(),
      ...[...this.receipts.values()].map((record) => record.key),
    ]))
      if (!keys.has(key)) this.invalidate(key);
  }

  private pruneReceipts(): void {
    const now = this.now();
    for (const [receipt, record] of this.receipts)
      if (record.issuedAt > now || record.issuedAt + RECEIPT_TTL <= now)
        this.receipts.delete(receipt);
    while (this.receipts.size > MAX_RECEIPTS)
      this.receipts.delete(this.receipts.keys().next().value ?? '');
  }

  /**
   * 仅在 Main 内存绑定选号凭证代际；硬失败提升查询代际，不撤销同身份并发模型请求的票。
   *
   * Bind selection to a credential generation in Main memory only. Hard failures advance query generations without revoking concurrent same-identity model receipts.
   */
  async issueSelectionReceipt(poolId: string, key: string): Promise<string | undefined> {
    this.pruneReceipts();
    const generation = this.credentialGenerations.get(key) ?? 0;
    const identity = await this.identity(key);
    if (!identity || generation !== (this.credentialGenerations.get(key) ?? 0)) return undefined;
    const receipt = randomUUID();
    this.receipts.set(receipt, { poolId, key, identity, generation, issuedAt: this.now() });
    this.pruneReceipts();
    return receipt;
  }

  async validateFailure(
    poolId: string,
    failed?: OauthPoolFailure & { selectionReceipt?: string }
  ): Promise<OauthPoolFailure | undefined> {
    this.pruneReceipts();
    if (
      !failed?.selectionReceipt ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        failed.selectionReceipt
      )
    )
      return undefined;
    const record = this.receipts.get(failed.selectionReceipt);
    if (!record || record.poolId !== poolId || record.key !== failed.accountKey) return undefined;
    const identity = await this.identity(failed.accountKey);
    if (
      !identity ||
      identity !== record.identity ||
      record.generation !== (this.credentialGenerations.get(failed.accountKey) ?? 0) ||
      this.receipts.get(failed.selectionReceipt) !== record ||
      record.issuedAt + RECEIPT_TTL <= this.now()
    )
      return undefined;
    return failed;
  }

  private matchesFailureIdentity(
    poolId: string,
    failed: OauthPoolFailure & { selectionReceipt?: string },
    identity: string
  ): boolean {
    if (!failed.selectionReceipt) return true;
    const record = this.receipts.get(failed.selectionReceipt);
    return (
      !!record &&
      record.poolId === poolId &&
      record.key === failed.accountKey &&
      record.identity === identity &&
      record.generation === (this.credentialGenerations.get(failed.accountKey) ?? 0) &&
      record.issuedAt + RECEIPT_TTL > this.now()
    );
  }

  private async identity(key: string): Promise<string | undefined> {
    if (!isCodexAccountKey(key) || key.length > 100) return undefined;
    let identity: string | undefined;
    try {
      identity = await this.deps.identity(key);
    } catch {
      return undefined;
    }
    if (!validIdentity(identity)) {
      this.invalidate(key);
      return undefined;
    }
    const previous =
      this.evidence.get(key)?.identity ??
      this.cache.get(key)?.identity ??
      this.inFlight.get(key)?.identity;
    if (previous && previous !== identity) this.invalidate(key);
    return identity;
  }

  async getUsage(key: string): Promise<OauthAccountUsage> {
    const identity = await this.identity(key);
    if (!identity) return { key, windows: [], error: 'OAuth account is unavailable' };
    return this.query(key, identity);
  }

  private async query(key: string, identity: string): Promise<OauthAccountUsage> {
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached?.identity === identity && cached.expiresAt > now) return cached.value;
    const pending = this.inFlight.get(key);
    if (pending?.identity === identity) return pending.promise;
    const generation = this.generations.get(key) ?? 0;
    const promise = (async () => {
      let result: OauthAccountUsage;
      try {
        result = await this.deps.query(key);
      } catch {
        result = { key, windows: [], error: 'Quota query failed' };
      }
      const checkedAt = this.now();
      const windows =
        result.key === key && !result.error ? validWindows(result.windows, checkedAt) : undefined;
      const partial =
        result.key === key &&
        !result.error &&
        Array.isArray(result.windows) &&
        result.windows.length <= 20
          ? result.windows.flatMap((window) => validWindows([window], checkedAt) ?? [])
          : [];
      const value: OauthAccountUsage = windows
        ? { key, windows }
        : {
            key,
            windows: partial,
            error: result.error || 'Quota information is unavailable or stale',
          };
      // 请求完成时重新比对身份及代际；旧请求不能写入重登账号，也不能覆盖新失败证据。
      //
      // Recheck identity/generation on completion: stale requests cannot update reauthenticated accounts or overwrite newer failure evidence.
      const latestIdentity = await this.identity(key);
      if (latestIdentity !== identity || (this.generations.get(key) ?? 0) !== generation) {
        return {
          key,
          windows: [],
          error: 'Quota query became stale after account or failure state changed',
        };
      }
      const previous = this.evidence.get(key);
      const resetDeadlines = [
        previous?.hardUntil,
        ...(previous?.windows ?? [])
          .filter((window) => window.usedPercent >= 100)
          .map((window) => window.resetsAt),
      ];
      if (
        resetDeadlines.some((reset) => reset !== undefined && now < reset && reset <= checkedAt)
      ) {
        // 恢复证据必须来自 reset 后发起的查询，不能把跨 reset 的旧查询视为确认恢复。
        //
        // Recovery evidence must come from a query started after reset, not an older request completing across reset.
        return {
          key,
          windows: [],
          error: 'Quota reset occurred during the query; query again to confirm recovery',
        };
      }
      {
        const hardUntil = previous?.hardUntil;
        if (windows) {
          this.evidence.set(key, {
            identity,
            checkedAt,
            windows: windows.map((window) => ({
              usedPercent: window.usedPercent,
              resetsAt:
                window.resetsAt ?? (window.usedPercent >= 100 ? checkedAt + TTL : undefined),
            })),
            ...(hardUntil && hardUntil > checkedAt ? { hardUntil } : {}),
          });
        } else if (partial.some((window) => window.usedPercent >= 100)) {
          // 部分坏窗口不能抵消已知耗尽；只有完整有效的非耗尽窗口集合才是恢复证据。
          //
          // Invalid sibling windows cannot cancel known exhaustion; recovery requires a complete valid non-exhausted window set.
          const blocked = [
            ...(previous?.windows ?? []).filter(
              (window) => window.usedPercent >= 100 && (window.resetsAt ?? 0) > checkedAt
            ),
            ...partial
              .filter((window) => window.usedPercent >= 100)
              .map((window) => ({
                usedPercent: window.usedPercent,
                resetsAt: window.resetsAt ?? checkedAt + TTL,
              })),
          ];
          this.evidence.set(key, {
            identity,
            checkedAt,
            windows: [
              ...new Map(blocked.map((window) => [window.resetsAt, window])).values(),
            ].slice(0, 20),
            ...(hardUntil && hardUntil > checkedAt ? { hardUntil } : {}),
          });
        }
        const deadlines = [
          checkedAt + (windows ? TTL : ERROR_TTL),
          ...(windows ?? []).flatMap((window) => (window.resetsAt ? [window.resetsAt] : [])),
          ...(hardUntil && hardUntil > checkedAt ? [hardUntil] : []),
        ];
        this.cache.set(key, { identity, value, checkedAt, expiresAt: Math.min(...deadlines) });
        this.save();
      }
      return value;
    })();
    const flight = { identity, promise };
    this.inFlight.set(key, flight);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
    }
  }

  private blocked(key: string): boolean {
    const now = this.now();
    const record = this.evidence.get(key);
    return (
      !!record &&
      ((record.hardUntil ?? 0) > now ||
        record.windows.some((window) => window.usedPercent >= 100 && (window.resetsAt ?? 0) > now))
    );
  }

  /**
   * 选号共享单调时钟预算，只限制等待，不取消 UI/其它池共用的查询，也不把超时写成额度证据。
   * race 会处理迟到的拒绝；后台结果仍经 query 的身份及代际校验后缓存。
   *
   * Selection shares a monotonic-clock budget that bounds waiting, without cancelling queries shared with UI/other pools or recording timeout as quota evidence.
   * The race handles late rejection; background results still pass query's identity and generation checks before caching.
   */
  private async queryWithinBudget(key: string, identity: string, deadline: number): Promise<void> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remaining);
    });
    try {
      await Promise.race([this.query(key, identity), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private needsResetCheck(key: string): boolean {
    const now = this.now();
    const record = this.evidence.get(key);
    const checkedAt = this.cache.get(key)?.checkedAt ?? 0;
    return (
      !!record &&
      [record.hardUntil, ...record.windows.map((window) => window.resetsAt)].some(
        (reset) => reset !== undefined && reset <= now && checkedAt < reset
      )
    );
  }

  async select(
    poolId: string,
    ordered: readonly string[],
    eligible: readonly string[],
    failed?: OauthPoolFailure
  ): Promise<{ accountKey?: string; error?: string; warning?: string }> {
    const deadline = performance.now() + SELECTION_QUERY_BUDGET;
    if (failed && ordered.includes(failed.accountKey)) {
      const identity = await this.identity(failed.accountKey);
      if (identity && this.matchesFailureIdentity(poolId, failed, identity)) {
        const now = this.now();
        const until =
          failed.resetAt && validTime(failed.resetAt, now) && failed.resetAt > now
            ? failed.resetAt
            : now + 300_000;
        const previous = this.evidence.get(failed.accountKey);
        this.evidence.set(failed.accountKey, {
          identity,
          checkedAt: now,
          windows: previous?.windows ?? [],
          hardUntil: Math.max(previous?.hardUntil ?? 0, until),
        });
        // 硬故障必须让尚未过期的健康缓存也在封锁截止后重新查证。
        //
        // A hard failure forces revalidation at its deadline even if a healthy cache was still fresh.
        this.cache.delete(failed.accountKey);
        this.generations.set(failed.accountKey, (this.generations.get(failed.accountKey) ?? 0) + 1);
        this.inFlight.delete(failed.accountKey);
        this.save();
      }
    }
    const start = Math.max(0, ordered.indexOf(this.current.get(poolId) ?? ''));
    const candidates = [...ordered.slice(start), ...ordered.slice(0, start)].filter((key) =>
      eligible.includes(key)
    );
    let unknown: string | undefined;
    for (const key of candidates) {
      const identity = await this.identity(key);
      if (!identity) continue;
      if (!this.blocked(key) || this.needsResetCheck(key))
        await this.queryWithinBudget(key, identity, deadline);
      if ((await this.identity(key)) !== identity) continue;
      if (this.blocked(key)) continue;
      const cached = this.cache.get(key);
      if (cached?.identity === identity && !cached.value.error && cached.expiresAt > this.now()) {
        this.current.set(poolId, key);
        return { accountKey: key };
      }
      unknown ??= key;
    }
    if (unknown) {
      this.current.set(poolId, unknown);
      return {
        accountKey: unknown,
        warning:
          'Quota could not be confirmed for any available account; using an unknown account without inferring exhaustion.',
      };
    }
    const recovery = candidates.flatMap((key) => {
      const record = this.evidence.get(key);
      const resets = [
        record?.hardUntil ?? 0,
        ...(record?.windows ?? [])
          .filter((window) => window.usedPercent >= 100)
          .map((window) => window.resetsAt ?? 0),
      ].filter((reset) => reset > this.now());
      return resets.length ? [Math.max(...resets)] : [];
    });
    return {
      error:
        OAUTH_POOL_EXHAUSTED +
        (recovery.length
          ? ` Earliest quota recheck: ${new Date(Math.min(...recovery)).toISOString()}. Recovery must be confirmed with the provider.`
          : ''),
    };
  }
}
