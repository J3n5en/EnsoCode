import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestBodyUsage } from '@shared/requestBodyUsage';

export type RequestBodyObserver = (usage: RequestBodyUsage) => void;

export interface RequestBodyRequestMarker {
  sessionId?: string;
  signal?: AbortSignal;
}

const observers = new AsyncLocalStorage<{
  observer: RequestBodyObserver;
  request?: RequestBodyRequestMarker;
}>();

/** 每次 stream 创建一个 scope，SDK 的异步 payload / fetch / provider retry 继承它，不按共享 providerId 绑定。 */
export function runWithRequestBodyObserver<T>(
  observer: RequestBodyObserver,
  work: () => T,
  request?: RequestBodyRequestMarker
): T {
  return observers.run({ observer, request }, work);
}

export function reportRequestBodyUsage(
  bytes: number,
  limitBytes: number,
  stage: RequestBodyUsage['stage'],
  request?: RequestBodyRequestMarker
): void {
  const scope = observers.getStore();
  if (!scope) return;
  // 摘要使用独立 routing id；缓存预热复用 id，但使用独立 AbortController。
  // 两者照常受预算保护，不得把主请求的超限显示覆盖成一次小型维护请求。
  if (
    scope.request &&
    (scope.request.sessionId !== request?.sessionId || scope.request.signal !== request?.signal)
  )
    return;
  try {
    scope.observer({ bytes, limitBytes, stage, blocked: bytes > limitBytes, at: Date.now() });
  } catch {
    // 遥测不是授权/预算判断；IPC 已断开不能改变原请求结果，也不能使超限放行。
    console.warn('[request-body] observer failed');
  }
}
