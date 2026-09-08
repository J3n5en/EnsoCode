import { describe, expect, it } from 'vitest';
import {
  directBackoffDelay,
  initialDirectState,
  pickTransport,
  reduceDirect,
} from './directSession';

describe('guest direct session', () => {
  it('waits for an online capable peer before starting generation 1 negotiation', () => {
    const initial = initialDirectState('guest');
    const capable = reduceDirect(initial, { type: 'peer-capable', capable: true });

    expect(capable).toEqual({
      state: {
        role: 'guest',
        phase: 'idle',
        gen: 0,
        attempt: 0,
        capable: true,
        peerOnline: false,
      },
      actions: [],
    });

    expect(reduceDirect(capable.state, { type: 'peer-online', online: true })).toEqual({
      state: {
        role: 'guest',
        phase: 'negotiating',
        gen: 1,
        attempt: 0,
        capable: true,
        peerOnline: true,
      },
      actions: [
        { type: 'create-offer', gen: 1 },
        { type: 'start-timeout', gen: 1 },
      ],
    });
  });

  it('ignores a wrong-generation answer and applies the current-generation answer', () => {
    const state = {
      ...initialDirectState('guest'),
      phase: 'negotiating' as const,
      gen: 2,
      capable: true,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'answer', gen: 1 })).toEqual({ state, actions: [] });
    expect(reduceDirect(state, { type: 'answer', gen: 2 })).toEqual({
      state,
      actions: [{ type: 'apply-answer', gen: 2 }],
    });
  });

  it('connects on current-generation dc-open and resets the failure attempt', () => {
    const state = {
      ...initialDirectState('guest'),
      phase: 'negotiating' as const,
      gen: 3,
      attempt: 2,
      capable: true,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'dc-open', gen: 3 })).toEqual({
      state: { ...state, phase: 'connected', attempt: 0 },
      actions: [{ type: 'switch', transport: 'direct' }, { type: 'resync' }],
    });
  });

  it('falls back and schedules retry when the connected data channel closes', () => {
    const state = {
      ...initialDirectState('guest'),
      phase: 'connected' as const,
      gen: 3,
      capable: true,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'dc-close', gen: 3 })).toEqual({
      state: { ...state, phase: 'cooldown', attempt: 1 },
      actions: [
        { type: 'destroy-peer' },
        { type: 'switch', transport: 'relay' },
        { type: 'resync' },
        { type: 'schedule-retry', attempt: 1 },
      ],
    });
  });

  it('closes a timed-out negotiation and enters incremented cooldown', () => {
    const state = {
      ...initialDirectState('guest'),
      phase: 'negotiating' as const,
      gen: 4,
      attempt: 2,
      capable: true,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'negotiate-timeout', gen: 4 })).toEqual({
      state: { ...state, phase: 'cooldown', attempt: 3 },
      actions: [
        { type: 'send-close', gen: 4 },
        { type: 'destroy-peer' },
        { type: 'schedule-retry', attempt: 3 },
      ],
    });
  });

  it('retries after cooldown only while the peer remains capable and online', () => {
    const ready = {
      ...initialDirectState('guest'),
      phase: 'cooldown' as const,
      gen: 3,
      attempt: 2,
      capable: true,
      peerOnline: true,
    };
    const unavailable = { ...ready, capable: false };

    expect(reduceDirect(ready, { type: 'cooldown-elapsed' })).toEqual({
      state: { ...ready, phase: 'negotiating', gen: 4 },
      actions: [
        { type: 'create-offer', gen: 4 },
        { type: 'start-timeout', gen: 4 },
      ],
    });
    expect(reduceDirect(unavailable, { type: 'cooldown-elapsed' })).toEqual({
      state: { ...unavailable, phase: 'idle' },
      actions: [],
    });
  });

  it('restarts negotiation immediately after a connected network change', () => {
    const state = {
      ...initialDirectState('guest'),
      phase: 'connected' as const,
      gen: 4,
      attempt: 3,
      capable: true,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'network-change' })).toEqual({
      state: { ...state, phase: 'negotiating', gen: 5, attempt: 0 },
      actions: [
        { type: 'send-close', gen: 4 },
        { type: 'destroy-peer' },
        { type: 'switch', transport: 'relay' },
        { type: 'resync' },
        { type: 'create-offer', gen: 5 },
        { type: 'start-timeout', gen: 5 },
      ],
    });
  });

  it('does not interrupt negotiation when peer capability is repeated', () => {
    const state = {
      ...initialDirectState('guest'),
      phase: 'negotiating' as const,
      gen: 1,
      capable: true,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'peer-capable', capable: true })).toEqual({
      state,
      actions: [],
    });
  });

  it('returns to idle and relay when the connected peer is gone', () => {
    const state = {
      ...initialDirectState('guest'),
      phase: 'connected' as const,
      gen: 5,
      attempt: 2,
      capable: true,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'peer-gone' })).toEqual({
      state: {
        ...state,
        phase: 'idle',
        attempt: 0,
        capable: false,
        peerOnline: false,
      },
      actions: [{ type: 'destroy-peer' }, { type: 'switch', transport: 'relay' }],
    });
  });

  it('ignores stale dc-open generations', () => {
    const state = {
      ...initialDirectState('guest'),
      phase: 'negotiating' as const,
      gen: 6,
      capable: true,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'dc-open', gen: 5 })).toEqual({ state, actions: [] });
  });

  it('picks direct only for an open connected channel, then relay, then null', () => {
    const connected = {
      ...initialDirectState('guest'),
      phase: 'connected' as const,
      gen: 1,
    };

    expect(pickTransport(connected, true, true)).toBe('direct');
    expect(pickTransport(connected, false, true)).toBe('relay');
    expect(pickTransport(connected, false, false)).toBeNull();
  });

  it('calculates jittered exponential direct retry delay with a five-minute cap', () => {
    const midpoint = () => 0.5;

    expect(directBackoffDelay(0, midpoint)).toBe(1_000);
    expect(directBackoffDelay(5, midpoint)).toBe(32_000);
    expect(directBackoffDelay(20, midpoint)).toBe(300_000);
    expect(directBackoffDelay(0, () => 0)).toBe(700);
  });
});

describe('host direct session', () => {
  it('accepts the first offer and starts its negotiation timeout', () => {
    const state = initialDirectState('host');

    expect(reduceDirect(state, { type: 'offer', gen: 1 })).toEqual({
      state: { ...state, phase: 'negotiating', gen: 1 },
      actions: [
        { type: 'accept-offer', gen: 1 },
        { type: 'start-timeout', gen: 1 },
      ],
    });
  });

  it('ignores offers whose generation is not newer than the host generation', () => {
    const state = { ...initialDirectState('host'), gen: 2 };

    expect(reduceDirect(state, { type: 'offer', gen: 2 })).toEqual({ state, actions: [] });
    expect(reduceDirect(state, { type: 'offer', gen: 1 })).toEqual({ state, actions: [] });
  });

  it('replaces a connected peer when a newer offer arrives', () => {
    const state = {
      ...initialDirectState('host'),
      phase: 'connected' as const,
      gen: 2,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'offer', gen: 3 })).toEqual({
      state: { ...state, phase: 'negotiating', gen: 3 },
      actions: [
        { type: 'destroy-peer' },
        { type: 'switch', transport: 'relay' },
        { type: 'resync' },
        { type: 'accept-offer', gen: 3 },
        { type: 'start-timeout', gen: 3 },
      ],
    });
  });

  it('applies current-generation ice while negotiating and ignores stale ice', () => {
    const state = {
      ...initialDirectState('host'),
      phase: 'negotiating' as const,
      gen: 3,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'ice', gen: 3 })).toEqual({
      state,
      actions: [{ type: 'apply-ice', gen: 3 }],
    });
    expect(reduceDirect(state, { type: 'ice', gen: 2 })).toEqual({ state, actions: [] });
  });

  it('connects on current-generation dc-open', () => {
    const state = {
      ...initialDirectState('host'),
      phase: 'negotiating' as const,
      gen: 3,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'dc-open', gen: 3 })).toEqual({
      state: { ...state, phase: 'connected' },
      actions: [{ type: 'switch', transport: 'direct' }, { type: 'resync' }],
    });
  });

  it('returns to idle on current-generation remote-close while preserving generation', () => {
    const state = {
      ...initialDirectState('host'),
      phase: 'connected' as const,
      gen: 4,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'remote-close', gen: 4 })).toEqual({
      state: { ...state, phase: 'idle' },
      actions: [
        { type: 'destroy-peer' },
        { type: 'switch', transport: 'relay' },
        { type: 'resync' },
      ],
    });
  });

  it('destroys a timed-out negotiation and returns to idle', () => {
    const state = {
      ...initialDirectState('host'),
      phase: 'negotiating' as const,
      gen: 4,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'negotiate-timeout', gen: 4 })).toEqual({
      state: { ...state, phase: 'idle' },
      actions: [{ type: 'destroy-peer' }],
    });
  });

  it('handles peer-gone and ignores guest-only events without resetting generation', () => {
    const state = {
      ...initialDirectState('host'),
      phase: 'connected' as const,
      gen: 5,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'peer-gone' })).toEqual({
      state: { ...state, phase: 'idle', peerOnline: false },
      actions: [
        { type: 'destroy-peer' },
        { type: 'switch', transport: 'relay' },
        { type: 'resync' },
      ],
    });
    expect(reduceDirect(state, { type: 'peer-capable', capable: true })).toEqual({
      state,
      actions: [],
    });
    expect(reduceDirect(state, { type: 'answer', gen: 5 })).toEqual({ state, actions: [] });
    expect(reduceDirect(state, { type: 'cooldown-elapsed' })).toEqual({ state, actions: [] });
  });
});
