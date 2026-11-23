import type { SecretaryContactOutboundHealth } from '@shared/types/secretary';
import type { ChannelFailure } from './channel';

/** 连续失败几次后开始暂停：偶发一两次失败照常重试 */
export const PAUSE_AFTER_FAILURES = 3;
/** 每次暂停的时长，逐级拉长，最长一小时一试 */
export const PAUSE_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

interface Health {
  failures: number;
  lastErrorAt: number;
  lastErrorCode: string;
  detail?: string;
  pluginCode?: string;
  userMessage?: string;
  pausedUntil?: number;
  suppressed: number;
  /** 这一轮暂停已经记过一条 warn */
  warned: boolean;
}

export type OutboundGate = 'open' | 'paused-first' | 'paused';

/**
 * 每个渠道的出站熔断：连续失败到阈值后按 PAUSE_STEPS_MS 暂停推送，
 * 到点放行一条试探；成功、入站消息或手动重试都清零。只记内存，重启即重试。
 */
export class OutboundHealth {
  private readonly channels = new Map<string, Health>();

  /** 现在能不能发；暂停中的每一条都计数，只有这一轮的第一条返回 paused-first */
  gate(channelId: string, now: number): OutboundGate {
    const health = this.channels.get(channelId);
    if (!health?.pausedUntil || now >= health.pausedUntil) return 'open';
    health.suppressed += 1;
    if (health.warned) return 'paused';
    health.warned = true;
    return 'paused-first';
  }

  fail(channelId: string, failure: ChannelFailure, now: number): void {
    const previous = this.channels.get(channelId);
    const failures = (previous?.failures ?? 0) + 1;
    const step = failures - PAUSE_AFTER_FAILURES;
    const pause = step >= 0 ? PAUSE_STEPS_MS[Math.min(step, PAUSE_STEPS_MS.length - 1)] : undefined;
    this.channels.set(channelId, {
      failures,
      lastErrorAt: now,
      lastErrorCode: failure.error,
      ...(failure.detail ? { detail: failure.detail } : {}),
      ...(failure.pluginCode ? { pluginCode: failure.pluginCode } : {}),
      ...(failure.userMessage ? { userMessage: failure.userMessage } : {}),
      ...(pause !== undefined ? { pausedUntil: now + pause } : {}),
      suppressed: previous?.suppressed ?? 0,
      warned: false,
    });
  }

  /** 清零；原来有记录才返回 true */
  reset(channelId: string): boolean {
    return this.channels.delete(channelId);
  }

  view(channelId: string): SecretaryContactOutboundHealth | undefined {
    const health = this.channels.get(channelId);
    if (!health) return undefined;
    return {
      state: health.failures >= PAUSE_AFTER_FAILURES ? 'paused' : 'degraded',
      consecutiveFailures: health.failures,
      lastErrorAt: health.lastErrorAt,
      lastErrorCode: health.lastErrorCode,
      ...(health.detail ? { detail: health.detail } : {}),
      ...(health.pluginCode ? { pluginCode: health.pluginCode } : {}),
      ...(health.userMessage ? { userMessage: health.userMessage } : {}),
      ...(health.pausedUntil !== undefined ? { pausedUntil: health.pausedUntil } : {}),
      suppressedCount: health.suppressed,
    };
  }
}
