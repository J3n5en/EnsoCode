import { describe, expect, it } from 'vitest';
import { directBackoffDelay, initialDirectState, reduceDirect } from './directSession';

describe('访客端直连会话', () => {
  it('等待在线且具备能力的对端后才发起第 1 代协商', () => {
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

  it('忽略错误代次的应答并应用当前代应答', () => {
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

  it('当前代数据通道打开后连接并重置失败次数', () => {
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

  it('已连接的数据通道关闭后回退并安排重试', () => {
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

  it('协商超时后关闭当前代并以递增次数进入冷却', () => {
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

  it('仅在对端仍具备能力且在线时于冷却结束后重试', () => {
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

  it('已连接时网络变化会立即重新协商', () => {
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

  it('重复上报对端能力不会中断协商', () => {
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

  it('已连接对端离线后回到空闲和中继', () => {
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

  it('忽略过期代次的数据通道打开事件', () => {
    const state = {
      ...initialDirectState('guest'),
      phase: 'negotiating' as const,
      gen: 6,
      capable: true,
      peerOnline: true,
    };

    expect(reduceDirect(state, { type: 'dc-open', gen: 5 })).toEqual({ state, actions: [] });
  });

  it('计算带抖动的指数退避且上限为五分钟', () => {
    const midpoint = () => 0.5;

    expect(directBackoffDelay(0, midpoint)).toBe(1_000);
    expect(directBackoffDelay(5, midpoint)).toBe(32_000);
    expect(directBackoffDelay(20, midpoint)).toBe(300_000);
    expect(directBackoffDelay(0, () => 0)).toBe(700);
  });
});

describe('主机端直连会话', () => {
  it('接受首次提议并启动协商超时', () => {
    const state = initialDirectState('host');

    expect(reduceDirect(state, { type: 'offer', gen: 1 })).toEqual({
      state: { ...state, phase: 'negotiating', gen: 1 },
      actions: [
        { type: 'accept-offer', gen: 1 },
        { type: 'start-timeout', gen: 1 },
      ],
    });
  });

  it('忽略代次不高于主机当前代的提议', () => {
    const state = { ...initialDirectState('host'), gen: 2 };

    expect(reduceDirect(state, { type: 'offer', gen: 2 })).toEqual({ state, actions: [] });
    expect(reduceDirect(state, { type: 'offer', gen: 1 })).toEqual({ state, actions: [] });
  });

  it('收到较新代次提议时替换已连接对端', () => {
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

  it('协商中应用当前代 ICE 并忽略过期 ICE', () => {
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

  it('当前代数据通道打开后建立连接', () => {
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

  it('收到当前代远端关闭时回到空闲并保留代次', () => {
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

  it('协商超时后销毁对端并回到空闲', () => {
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

  it('处理对端离线并忽略访客端专属事件且不重置代次', () => {
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
