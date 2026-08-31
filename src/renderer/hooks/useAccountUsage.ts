import type { OauthAccountUsage } from '@shared/types';
import { useEffect, useState } from 'react';

/** 订阅额度查询的节流缓存：同一账号 60s 内命中缓存，不重复打厂商额度端点。
 *  用 Map 而非 Record —— accountKey 集合是运行时动态的订阅账号（用户可随时增删登录）。 */
export const usageCache = new Map<string, { data: OauthAccountUsage; fetchedAt: number }>();
export const USAGE_CACHE_TTL_MS = 60_000;

/** 同一账号并发多次不重复发起网络请求：共享同一个进行中的 promise。 */
const usageInFlight = new Map<string, Promise<OauthAccountUsage>>();

export function fetchAccountUsage(accountKey: string): Promise<OauthAccountUsage> {
  const inFlight = usageInFlight.get(accountKey);
  if (inFlight) return inFlight;
  const promise = window.electronAPI.providers
    .oauthAccountUsage(accountKey)
    .then((result) => {
      usageCache.set(accountKey, { data: result, fetchedAt: Date.now() });
      return result;
    })
    .finally(() => {
      usageInFlight.delete(accountKey);
    });
  usageInFlight.set(accountKey, promise);
  return promise;
}

/** 简版订阅额度 hook：挂载/换账号时缓存过期才拉取；不做 TTL 自动刷新（那是 StatsLine
 *  带 1s tick 的 useOauthAccountUsage 的事）。返回值与请求它的 accountKey 绑定，
 *  账号切换时不会短暂显示上一个账号的旧数据。 */
export function useCachedAccountUsage(
  accountKey: string | undefined
): OauthAccountUsage | undefined {
  const [state, setState] = useState<{ key: string; data: OauthAccountUsage } | undefined>(() => {
    if (!accountKey) return undefined;
    const cached = usageCache.get(accountKey);
    return cached ? { key: accountKey, data: cached.data } : undefined;
  });

  useEffect(() => {
    if (!accountKey) return;
    let cancelled = false;
    const cached = usageCache.get(accountKey);
    if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
      setState({ key: accountKey, data: cached.data });
      return;
    }
    fetchAccountUsage(accountKey)
      .then((result) => {
        if (!cancelled) setState({ key: accountKey, data: result });
      })
      .catch(() => {
        if (!cancelled) {
          setState((current) => (current?.key === accountKey ? undefined : current));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountKey]);

  return accountKey && state?.key === accountKey ? state.data : undefined;
}
