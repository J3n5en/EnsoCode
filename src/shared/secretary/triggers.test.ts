import { describe, expect, it } from 'vitest';
import {
  buildTriggerUrls,
  DEFAULT_TRIGGER_COALESCE_MS,
  DEFAULT_TRIGGER_PORT,
  isTriggerId,
  parseTriggerCreateDraft,
  parseTriggerInboundPayload,
  parseTriggerPort,
  parseTriggersFile,
  parseTriggerUpdateDraft,
  TRIGGER_PAYLOAD_MAX_CHARS,
} from './triggers';

describe('triggers shared validation & parsing', () => {
  it('validates trigger ids and local ports', () => {
    expect(isTriggerId('trg-abc12345')).toBe(true);
    expect(isTriggerId('trg-0a1b2c3d4e5f')).toBe(true);
    expect(isTriggerId('../etc/passwd')).toBe(false);
    expect(isTriggerId('trg-ABC')).toBe(false);
    expect(isTriggerId('')).toBe(false);

    expect(parseTriggerPort(DEFAULT_TRIGGER_PORT)).toBe(DEFAULT_TRIGGER_PORT);
    expect(parseTriggerPort(0)).toBe(0);
    expect(parseTriggerPort(1024)).toBe(1024);
    expect(parseTriggerPort(65535)).toBe(65535);
    expect(parseTriggerPort(80)).toBeNull();
    expect(parseTriggerPort(70000)).toBeNull();
    expect(parseTriggerPort('17654')).toBeNull();
    expect(parseTriggerPort(17654.5)).toBeNull();
  });

  it('builds loopback HTTP and WS URLs', () => {
    expect(buildTriggerUrls(17654, 'trg-abc12345')).toEqual({
      httpUrl: 'http://127.0.0.1:17654/v1/triggers/trg-abc12345',
      wsUrl: 'ws://127.0.0.1:17654/v1/triggers/trg-abc12345/ws',
    });
  });

  it('validates create and update drafts strictly', () => {
    expect(parseTriggerCreateDraft({ name: '  微信售后群  ' })).toEqual({
      ok: true,
      draft: {
        name: '微信售后群',
        enabled: true,
        coalesceMs: DEFAULT_TRIGGER_COALESCE_MS,
      },
    });

    expect(
      parseTriggerCreateDraft({
        name: 'CI 告警',
        instruction: '只汇总失败用例，不自动改代码',
        coalesceMs: 0,
        enabled: false,
      })
    ).toEqual({
      ok: true,
      draft: {
        name: 'CI 告警',
        instruction: '只汇总失败用例，不自动改代码',
        coalesceMs: 0,
        enabled: false,
      },
    });

    expect(parseTriggerCreateDraft({ name: '   ' }).ok).toBe(false);
    expect(parseTriggerCreateDraft({ name: 'ok', coalesceMs: -1 }).ok).toBe(false);
    expect(parseTriggerCreateDraft({ name: 'ok', coalesceMs: 60_001 }).ok).toBe(false);

    expect(
      parseTriggerUpdateDraft({ enabled: false, instruction: null, coalesceMs: 5000 })
    ).toEqual({
      ok: true,
      patch: { enabled: false, instruction: null, coalesceMs: 5000 },
    });
    expect(parseTriggerUpdateDraft({ name: '' }).ok).toBe(false);
    expect(parseTriggerUpdateDraft('bad').ok).toBe(false);
  });

  it('parses persisted triggers.json defensively and drops corrupted rows', () => {
    const parsed = parseTriggersFile({
      version: 1,
      triggers: [
        {
          id: 'trg-1234abcd',
          name: '售后群',
          enabled: true,
          instruction: '先核对订单号',
          coalesceMs: 4000,
          createdAt: 1000,
          updatedAt: 2000,
          lastFiredAt: 3000,
          fireCount: 5,
        },
        { id: 'bad-id', name: 'ignored', enabled: true, createdAt: 1, updatedAt: 1 },
        { id: 'trg-9999ffff', name: '', enabled: true, createdAt: 1, updatedAt: 1 },
      ],
    });
    expect(parsed).toEqual([
      {
        id: 'trg-1234abcd',
        name: '售后群',
        enabled: true,
        instruction: '先核对订单号',
        coalesceMs: 4000,
        createdAt: 1000,
        updatedAt: 2000,
        lastFiredAt: 3000,
        fireCount: 5,
      },
    ]);
  });

  it('parses JSON, arbitrary JSON fallback, and plain text inbound payloads', () => {
    expect(
      parseTriggerInboundPayload(
        JSON.stringify({
          eventId: 'wx-9981',
          source: '参半群',
          text: '客户反馈破损',
          data: { orderId: 'ORD-1' },
          at: 1700000000000,
        }),
        'application/json; charset=utf-8'
      )
    ).toEqual({
      ok: true,
      event: {
        eventId: 'wx-9981',
        source: '参半群',
        payload: '客户反馈破损\n{"orderId":"ORD-1"}',
        at: 1700000000000,
      },
    });

    // Legacy webhook JSON without a `text` field still works cleanly
    const legacy = parseTriggerInboundPayload(
      JSON.stringify({ group: '亳州群', count: 2 }),
      'application/json'
    );
    expect(legacy).toEqual({
      ok: true,
      event: {
        payload: '{"group":"亳州群","count":2}',
      },
    });

    // Plain text body works directly
    expect(parseTriggerInboundPayload('构建失败：exit 1', 'text/plain')).toEqual({
      ok: true,
      event: { payload: '构建失败：exit 1' },
    });

    // Empty body is rejected
    expect(parseTriggerInboundPayload('   ', 'text/plain').ok).toBe(false);
    expect(parseTriggerInboundPayload('{broken', 'application/json').ok).toBe(false);

    // Oversized payload is clipped to TRIGGER_PAYLOAD_MAX_CHARS
    const long = parseTriggerInboundPayload(
      'a'.repeat(TRIGGER_PAYLOAD_MAX_CHARS + 50),
      'text/plain'
    );
    expect(long.ok).toBe(true);
    if (long.ok) {
      expect(long.event.payload.length).toBeLessThanOrEqual(TRIGGER_PAYLOAD_MAX_CHARS + 1);
    }
  });
});
