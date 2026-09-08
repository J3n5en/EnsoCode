/**
 * 直连协商状态机（纯 reducer，三端共用）。guest 发起并驱动重试，host 只应答；
 * `gen` 每轮递增，不等于当前代的信令/事件一律丢弃，防网络切换后迟到的候选污染新一轮。
 * 中继侧断开（peer-online false / ws close）不拆直连：直连生死只看自身与本机网络变化。
 */

export type DirectRole = 'guest' | 'host';
export type DirectPhase = 'idle' | 'negotiating' | 'connected' | 'cooldown';
export type DirectTransport = 'direct' | 'relay';

export interface DirectState {
  role: DirectRole;
  phase: DirectPhase;
  /** 当前代，0 = 尚未协商过 */
  gen: number;
  /** 连续失败次数，退避用 */
  attempt: number;
  /** guest：已见到 host 声明能力；host 不用 */
  capable: boolean;
  peerOnline: boolean;
}

export type DirectEvent =
  | { type: 'peer-capable'; capable: boolean }
  | { type: 'peer-online'; online: boolean }
  | { type: 'offer'; gen: number }
  | { type: 'answer'; gen: number }
  | { type: 'ice'; gen: number }
  | { type: 'remote-close'; gen: number }
  | { type: 'dc-open'; gen: number }
  | { type: 'dc-close'; gen: number }
  | { type: 'negotiate-timeout'; gen: number }
  | { type: 'cooldown-elapsed' }
  | { type: 'network-change' }
  | { type: 'peer-gone' };

export type DirectAction =
  | { type: 'create-offer'; gen: number }
  | { type: 'accept-offer'; gen: number }
  | { type: 'apply-answer'; gen: number }
  | { type: 'apply-ice'; gen: number }
  | { type: 'start-timeout'; gen: number }
  | { type: 'destroy-peer' }
  | { type: 'send-close'; gen: number }
  | { type: 'switch'; transport: DirectTransport }
  | { type: 'resync' }
  | { type: 'schedule-retry'; attempt: number };

export interface DirectStep {
  state: DirectState;
  actions: DirectAction[];
}

/** 协商超时：要等 STUN 往返 + 跨网 ICE 检查 */
export const DIRECT_NEGOTIATE_TIMEOUT_MS = 15_000;

export function initialDirectState(role: DirectRole): DirectState {
  return { role, phase: 'idle', gen: 0, attempt: 0, capable: false, peerOnline: false };
}

const noop = (state: DirectState): DirectStep => ({ state, actions: [] });

/** 拆掉当前 peer；若在用直连则切回中继并触发重同步 */
function teardown(state: DirectState): DirectAction[] {
  if (state.phase === 'idle' || state.phase === 'cooldown') return [];
  const actions: DirectAction[] = [{ type: 'destroy-peer' }];
  if (state.phase === 'connected') {
    actions.push({ type: 'switch', transport: 'relay' }, { type: 'resync' });
  }
  return actions;
}

function startNegotiation(state: DirectState): DirectStep {
  const gen = state.gen + 1;
  return {
    state: { ...state, phase: 'negotiating', gen },
    actions: [
      { type: 'create-offer', gen },
      { type: 'start-timeout', gen },
    ],
  };
}

/** guest 在 idle/cooldown 且对端可用时立即发起，否则落回 idle */
function maybeStart(state: DirectState, prefix: DirectAction[]): DirectStep {
  if (state.capable && state.peerOnline) {
    const next = startNegotiation(state);
    return { state: next.state, actions: [...prefix, ...next.actions] };
  }
  return { state: { ...state, phase: 'idle' }, actions: prefix };
}

function reduceGuest(state: DirectState, event: DirectEvent): DirectStep {
  const current = (gen: number): boolean => gen === state.gen;
  switch (event.type) {
    case 'peer-capable': {
      if (!event.capable) {
        // host 降级：拆干净，等它再次声明
        return { state: { ...state, capable: false, phase: 'idle' }, actions: teardown(state) };
      }
      const next = { ...state, capable: true };
      return state.phase === 'idle' ? maybeStart(next, []) : noop(next);
    }
    case 'peer-online': {
      const next = { ...state, peerOnline: event.online };
      return event.online && state.phase === 'idle' ? maybeStart(next, []) : noop(next);
    }
    case 'answer':
      return state.phase === 'negotiating' && current(event.gen)
        ? { state, actions: [{ type: 'apply-answer', gen: event.gen }] }
        : noop(state);
    case 'ice':
      return (state.phase === 'negotiating' || state.phase === 'connected') && current(event.gen)
        ? { state, actions: [{ type: 'apply-ice', gen: event.gen }] }
        : noop(state);
    case 'dc-open':
      return state.phase === 'negotiating' && current(event.gen)
        ? {
            state: { ...state, phase: 'connected', attempt: 0 },
            actions: [{ type: 'switch', transport: 'direct' }, { type: 'resync' }],
          }
        : noop(state);
    case 'negotiate-timeout': {
      if (state.phase !== 'negotiating' || !current(event.gen)) return noop(state);
      const attempt = state.attempt + 1;
      return {
        state: { ...state, phase: 'cooldown', attempt },
        actions: [
          { type: 'send-close', gen: event.gen },
          { type: 'destroy-peer' },
          { type: 'schedule-retry', attempt },
        ],
      };
    }
    case 'dc-close': {
      if (!current(event.gen)) return noop(state);
      const attempt = state.attempt + 1;
      if (state.phase === 'connected') {
        return {
          state: { ...state, phase: 'cooldown', attempt },
          actions: [...teardown(state), { type: 'schedule-retry', attempt }],
        };
      }
      if (state.phase === 'negotiating') {
        return {
          state: { ...state, phase: 'cooldown', attempt },
          actions: [
            { type: 'send-close', gen: event.gen },
            { type: 'destroy-peer' },
            { type: 'schedule-retry', attempt },
          ],
        };
      }
      return noop(state);
    }
    case 'cooldown-elapsed':
      return state.phase === 'cooldown' ? maybeStart(state, []) : noop(state);
    case 'network-change': {
      const prefix: DirectAction[] =
        state.phase === 'negotiating' || state.phase === 'connected'
          ? [{ type: 'send-close', gen: state.gen }, ...teardown(state)]
          : [];
      return maybeStart({ ...state, attempt: 0 }, prefix);
    }
    case 'peer-gone': {
      const actions = teardown(state).filter((a) => a.type !== 'resync');
      return {
        state: { ...state, phase: 'idle', attempt: 0, capable: false, peerOnline: false },
        actions,
      };
    }
    default:
      return noop(state);
  }
}

function reduceHost(state: DirectState, event: DirectEvent): DirectStep {
  const current = (gen: number): boolean => gen === state.gen;
  const toIdle = (): DirectStep => ({
    state: { ...state, phase: 'idle' },
    actions: teardown(state),
  });
  switch (event.type) {
    case 'peer-online':
      return noop({ ...state, peerOnline: event.online });
    case 'offer': {
      if (event.gen <= state.gen) return noop(state);
      return {
        state: { ...state, phase: 'negotiating', gen: event.gen },
        actions: [
          ...teardown(state),
          { type: 'accept-offer', gen: event.gen },
          { type: 'start-timeout', gen: event.gen },
        ],
      };
    }
    case 'ice':
      return (state.phase === 'negotiating' || state.phase === 'connected') && current(event.gen)
        ? { state, actions: [{ type: 'apply-ice', gen: event.gen }] }
        : noop(state);
    case 'dc-open':
      return state.phase === 'negotiating' && current(event.gen)
        ? {
            state: { ...state, phase: 'connected' },
            actions: [{ type: 'switch', transport: 'direct' }, { type: 'resync' }],
          }
        : noop(state);
    case 'dc-close':
    case 'negotiate-timeout':
    case 'remote-close':
      return current(event.gen) && state.phase !== 'idle' ? toIdle() : noop(state);
    case 'network-change':
      return toIdle();
    case 'peer-gone':
      return { state: { ...state, phase: 'idle', peerOnline: false }, actions: teardown(state) };
    default:
      return noop(state);
  }
}

export function reduceDirect(state: DirectState, event: DirectEvent): DirectStep {
  return state.role === 'guest' ? reduceGuest(state, event) : reduceHost(state, event);
}

/** 直连重试退避：1s·2^attempt，上限 5 分钟，±30% 抖动。打不通的对称 NAT 会持续失败，别每 30s 折腾手机 */
export function directBackoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(300_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.7 + random() * 0.6));
}
