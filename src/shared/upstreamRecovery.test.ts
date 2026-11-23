import { describe, expect, it } from 'vitest';
import {
  classifyUpstreamError,
  nextPendingRetryDelayMs,
  nextUpstreamRetryAt,
  PENDING_DISPATCH_MAX_RETRIES,
  QUOTA_MAX_WINDOW_MS,
  QUOTA_RETRY_INTERVAL_MS,
  TRANSIENT_BACKOFF_MS,
  TRANSIENT_MAX_WINDOW_MS,
} from './upstreamRecovery';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('classifyUpstreamError', () => {
  it('classifies real transient errors including 503 No available accounts and 502', () => {
    expect(classifyUpstreamError({ statusCode: 503, error: 'No available accounts' }).kind).toBe(
      'transient'
    );
    expect(
      classifyUpstreamError({ error: '503 Service Unavailable: No available accounts' }).kind
    ).toBe('transient');
    // 不带 503 状态码的 No available accounts 也必须判瞬态
    expect(classifyUpstreamError({ error: 'No available accounts' }).kind).toBe('transient');
    expect(
      classifyUpstreamError({ error: 'No available ChatGPT OAuth accounts in this activity.' }).kind
    ).toBe('transient');
    expect(
      classifyUpstreamError({
        statusCode: 502,
        error: 'Upstream service temporarily unavailable',
      }).kind
    ).toBe('transient');
    expect(
      classifyUpstreamError({ error: '502 Bad Gateway: Upstream service temporarily unavailable' })
        .kind
    ).toBe('transient');
  });

  it('classifies 5xx, 429, network, timeout, overloaded, and retryExhausted as transient', () => {
    for (const sample of [
      { statusCode: 429, error: 'Rate limit exceeded, please retry later' },
      { error: 'HTTP 429 Too Many Requests' },
      { statusCode: 500, error: 'Internal server error' },
      { statusCode: 504, error: 'Gateway timeout' },
      { error: 'overloaded_error: Overloaded' },
      { error: 'fetch failed: ECONNRESET' },
      { error: 'request timed out after 60000ms (ETIMEDOUT)' },
      { error: 'socket hang up' },
      { error: 'stream ended unexpectedly' },
      { error: 'unknown transient blip', retryExhausted: true },
    ]) {
      expect(classifyUpstreamError(sample).kind, JSON.stringify(sample)).toBe('transient');
    }
  });

  it('classifies real 403 weekly usage limit exceeded and billing/quota errors as quota', () => {
    const weekly = classifyUpstreamError({
      statusCode: 403,
      error: 'weekly usage limit exceeded',
    });
    expect(weekly.kind).toBe('quota');
    expect(weekly.hint).toBeTruthy();

    for (const sample of [
      { error: '403 Forbidden: weekly usage limit exceeded' },
      { error: 'daily usage limit exceeded' },
      { error: 'usage_limit_reached' },
      {
        statusCode: 429,
        error:
          'You exceeded your current quota, please check your plan and billing details (insufficient_quota)',
      },
      { statusCode: 402, error: 'Payment required' },
      { error: 'Your credit balance is too low to access the API' },
      { error: 'billing hard limit has been reached' },
    ]) {
      expect(classifyUpstreamError(sample).kind, JSON.stringify(sample)).toBe('quota');
    }
  });

  it('extracts resetAt when quota error includes ISO timestamp or relative duration', () => {
    const now = Date.parse('2026-05-01T10:00:00Z');
    const iso = classifyUpstreamError(
      {
        statusCode: 403,
        error: 'weekly usage limit exceeded. Resets at 2026-05-01T14:00:00Z',
      },
      now
    );
    expect(iso.kind).toBe('quota');
    expect(iso.resetAt).toBe(Date.parse('2026-05-01T14:00:00Z'));

    const rel = classifyUpstreamError(
      {
        error: 'daily usage limit exceeded, try again in 2 hours',
      },
      now
    );
    expect(rel.kind).toBe('quota');
    expect(rel.resetAt).toBe(now + 2 * HOUR);
  });

  it('classifies real 403 IP recorded, 401 auth, 404 model, and 400 param errors as permanent with actionable hints', () => {
    const ipBlocked = classifyUpstreamError({
      statusCode: 403,
      error: 'Your IP 203.0.113.42 has been recorded and blocked',
    });
    expect(ipBlocked.kind).toBe('permanent');
    expect(ipBlocked.reason).toBe('ip-blocked');
    expect(ipBlocked.hint).toBeTruthy();

    const ipTextOnly = classifyUpstreamError({
      error: '403 Your IP 198.51.100.7 is recorded',
    });
    expect(ipTextOnly.kind).toBe('permanent');
    expect(ipTextOnly.reason).toBe('ip-blocked');

    const auth = classifyUpstreamError({ statusCode: 401, error: 'Invalid API key provided' });
    expect(auth.kind).toBe('permanent');
    expect(auth.reason).toBe('auth');
    expect(auth.hint).toBeTruthy();

    const model = classifyUpstreamError({
      statusCode: 404,
      error: 'model_not_found: The model `gpt-99` does not exist',
    });
    expect(model.kind).toBe('permanent');
    expect(model.reason).toBe('model');
    expect(model.hint).toBeTruthy();

    const badReq = classifyUpstreamError({
      statusCode: 400,
      error: 'invalid_request_error: messages must not be empty',
    });
    expect(badReq.kind).toBe('permanent');
    expect(badReq.reason).toBe('bad-request');

    const unknown = classifyUpstreamError({ error: 'something totally unrecognized' });
    expect(unknown.kind).toBe('permanent');
  });

  it('does not misclassify permanent 401/403 IP block even if retryExhausted is set', () => {
    expect(
      classifyUpstreamError({
        statusCode: 403,
        error: 'Your IP 1.2.3.4 has been recorded',
        retryExhausted: true,
      }).kind
    ).toBe('permanent');
    expect(
      classifyUpstreamError({
        statusCode: 401,
        error: 'invalid_api_key',
        retryExhausted: true,
      }).kind
    ).toBe('permanent');
  });
});

describe('nextUpstreamRetryAt', () => {
  it('follows 1, 2, 5, 10, 15 minute backoff then caps at 15 minutes for transient errors', () => {
    const since = 1_700_000_000_000;
    expect(TRANSIENT_BACKOFF_MS).toEqual([1 * MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN]);
    expect(TRANSIENT_MAX_WINDOW_MS).toBe(6 * HOUR);

    expect(nextUpstreamRetryAt({ kind: 'transient', attempt: 1, since, now: since })).toBe(
      since + 1 * MIN
    );
    expect(
      nextUpstreamRetryAt({ kind: 'transient', attempt: 2, since, now: since + 1 * MIN })
    ).toBe(since + 3 * MIN);
    expect(nextUpstreamRetryAt({ kind: 'transient', attempt: 3, since, now: since })).toBe(
      since + 5 * MIN
    );
    expect(nextUpstreamRetryAt({ kind: 'transient', attempt: 4, since, now: since })).toBe(
      since + 10 * MIN
    );
    expect(nextUpstreamRetryAt({ kind: 'transient', attempt: 5, since, now: since })).toBe(
      since + 15 * MIN
    );
    expect(nextUpstreamRetryAt({ kind: 'transient', attempt: 9, since, now: since })).toBe(
      since + 15 * MIN
    );
  });

  it('stops retrying transient errors once the 6-hour total window is exceeded', () => {
    const since = 1_700_000_000_000;
    expect(
      nextUpstreamRetryAt({
        kind: 'transient',
        attempt: 20,
        since,
        now: since + 6 * HOUR - 5 * MIN,
      })
    ).toBeNull();
    expect(
      nextUpstreamRetryAt({
        kind: 'transient',
        attempt: 25,
        since,
        now: since + 6 * HOUR + 1,
      })
    ).toBeNull();
  });

  it('uses 30-minute probes or provider resetAt (+1m) for quota errors up to 24-hour window', () => {
    const since = 1_700_000_000_000;
    expect(QUOTA_RETRY_INTERVAL_MS).toBe(30 * MIN);
    expect(QUOTA_MAX_WINDOW_MS).toBe(24 * HOUR);

    expect(nextUpstreamRetryAt({ kind: 'quota', attempt: 1, since, now: since })).toBe(
      since + 30 * MIN
    );
    // 如果 provider 给了 3 小时后的 resetAt，直接等到 resetAt + 1m
    const resetAt = since + 3 * HOUR;
    expect(nextUpstreamRetryAt({ kind: 'quota', attempt: 1, since, now: since, resetAt })).toBe(
      resetAt + MIN
    );
    // resetAt 已过期则回退 30 分钟
    expect(
      nextUpstreamRetryAt({ kind: 'quota', attempt: 2, since, now: resetAt + 2 * MIN, resetAt })
    ).toBe(resetAt + 32 * MIN);
    // 超过 24 小时总上限返回 null
    expect(
      nextUpstreamRetryAt({ kind: 'quota', attempt: 50, since, now: since + 24 * HOUR })
    ).toBeNull();
  });

  it('backs off pending dispatch transient failures up to 5 attempts', () => {
    expect(PENDING_DISPATCH_MAX_RETRIES).toBe(5);
    const delays = [1, 2, 3, 4, 5].map((attempt) => nextPendingRetryDelayMs(attempt));
    expect(delays.every((d) => typeof d === 'number' && d > 0)).toBe(true);
    expect(delays[0]!).toBeLessThanOrEqual(delays[4]!);
    expect(nextPendingRetryDelayMs(6)).toBeNull();
  });
});
