import { describe, expect, it } from 'vitest';
import { generateContentKey, sealFrame } from './crypto';
import { createFrameReplay } from './replay';

describe('连接前缀与计数器', () => {
  it('未握手前沿用随机 nonce，旧帧和重复帧都收', async () => {
    const key = generateContentKey();
    const replay = createFrameReplay();
    const legacy = await sealFrame(key, { type: 'snapshot' });
    expect(await replay.open(key, legacy)).toEqual({ type: 'snapshot' });
    expect(await replay.open(key, legacy)).toEqual({ type: 'snapshot' });
  });

  it('互致质询后拒绝重放和回退计数', async () => {
    const key = generateContentKey();
    const host = createFrameReplay();
    const phone = createFrameReplay();
    expect(await phone.open(key, await host.seal(key, { type: 'host-info' }))).toEqual({
      type: 'host-info',
    });
    expect(await host.open(key, await phone.seal(key, { type: 'snapshot' }))).toEqual({
      type: 'snapshot',
    });

    const first = await phone.seal(key, { type: 'prompt', text: 'hi' });
    const second = await phone.seal(key, { type: 'prompt', text: 'next' });
    expect(await host.open(key, first)).toEqual({ type: 'prompt', text: 'hi' });
    expect(await host.open(key, second)).toEqual({ type: 'prompt', text: 'next' });
    expect(await host.open(key, first)).toBeUndefined();
    expect(await host.open(key, second)).toBeUndefined();
  });

  it('旧会话的回声锁不住新连接', async () => {
    const key = generateContentKey();
    const host = createFrameReplay();
    const phone = createFrameReplay();
    await phone.open(key, await host.seal(key, { type: 'host-info' }));
    await host.open(key, await phone.seal(key, { type: 'snapshot' }));
    const old = await phone.seal(key, { type: 'prompt', text: 'old' });
    expect(await host.open(key, old)).toEqual({ type: 'prompt', text: 'old' });

    host.peerReset();
    const phone2 = createFrameReplay();
    await phone2.open(key, await host.seal(key, { type: 'host-info' }));
    await host.open(key, await phone2.seal(key, { type: 'snapshot' }));
    const fresh = await phone2.seal(key, { type: 'prompt', text: 'new' });
    expect(await host.open(key, fresh)).toEqual({ type: 'prompt', text: 'new' });
    expect(await host.open(key, old)).toBeUndefined();
  });

  it('锁定后错前缀的帧丢弃', async () => {
    const key = generateContentKey();
    const host = createFrameReplay();
    const phone = createFrameReplay();
    await phone.open(key, await host.seal(key, { type: 'host-info' }));
    await host.open(key, await phone.seal(key, { type: 'snapshot' }));
    const locked = await phone.seal(key, { type: 'prompt', text: 'hi' });
    expect(await host.open(key, locked)).toEqual({ type: 'prompt', text: 'hi' });
    const forged = await sealFrame(key, { type: 'prompt', text: 'forged' });
    expect(await host.open(key, forged)).toBeUndefined();
  });

  it('窗口内乱序只收一次', async () => {
    const key = generateContentKey();
    const host = createFrameReplay();
    const phone = createFrameReplay();
    await phone.open(key, await host.seal(key, { type: 'host-info' }));
    await host.open(key, await phone.seal(key, { type: 'snapshot' }));
    const frames = [];
    for (const text of ['a', 'b', 'c'])
      frames.push(await phone.seal(key, { type: 'prompt', text }));
    expect(await host.open(key, frames[2])).toEqual({ type: 'prompt', text: 'c' });
    expect(await host.open(key, frames[0])).toEqual({ type: 'prompt', text: 'a' });
    expect(await host.open(key, frames[1])).toEqual({ type: 'prompt', text: 'b' });
    expect(await host.open(key, frames[0])).toBeUndefined();
  });

  it('直连与中继混发导致数百帧乱序时，慢帧仍能收到且不能重放', async () => {
    const key = generateContentKey();
    const host = createFrameReplay();
    const phone = createFrameReplay();
    await phone.open(key, await host.seal(key, { type: 'host-info' }));
    await host.open(key, await phone.seal(key, { type: 'snapshot' }));

    const slow = await host.seal(key, { type: 'part', id: 'big' });
    let last: Uint8Array | undefined;
    for (let i = 0; i < 300; i++) {
      last = await host.seal(key, { type: 'rpc-event', i });
    }
    expect(await phone.open(key, last as Uint8Array)).toEqual({ type: 'rpc-event', i: 299 });
    expect(await phone.open(key, slow)).toEqual({ type: 'part', id: 'big' });
    expect(await phone.open(key, slow)).toBeUndefined();
  });

  it('4096 滑动窗口边界：落后 4095 帧仍接受且防重放，落后 4096 帧拒绝', async () => {
    const key = generateContentKey();
    const host = createFrameReplay();
    const phone = createFrameReplay();
    await phone.open(key, await host.seal(key, { type: 'host-info' }));
    await host.open(key, await phone.seal(key, { type: 'snapshot' }));

    const tooOld = await host.seal(key, { type: 'part', id: 'too-old' });
    const edge = await host.seal(key, { type: 'part', id: 'edge' });
    let latest: Uint8Array | undefined;
    for (let i = 0; i < 4095; i++) {
      latest = await host.seal(key, { type: 'rpc-event', i });
    }
    expect(await phone.open(key, latest as Uint8Array)).toEqual({ type: 'rpc-event', i: 4094 });
    expect(await phone.open(key, edge)).toEqual({ type: 'part', id: 'edge' });
    expect(await phone.open(key, edge)).toBeUndefined();
    expect(await phone.open(key, tooOld)).toBeUndefined();
  });

  it('对端重连后发送计数不回头', async () => {
    const key = generateContentKey();
    const host = createFrameReplay();
    const phone = createFrameReplay();
    await phone.open(key, await host.seal(key, { type: 'host-info' }));
    await host.open(key, await phone.seal(key, { type: 'snapshot' }));
    const before = await host.seal(key, { type: 'catalog' });
    await phone.open(key, before);
    phone.peerReset();
    await phone.open(key, await host.seal(key, { type: 'host-info' }));
    await host.open(key, await phone.seal(key, { type: 'snapshot' }));
    const after = await host.seal(key, { type: 'catalog' });
    expect(counterOf(after)).toBeGreaterThan(counterOf(before));
  });

  it('知道对端质询后只要求补一帧', async () => {
    const key = generateContentKey();
    const host = createFrameReplay();
    const phone = createFrameReplay();
    expect(phone.takeHello()).toBe(false);
    await phone.open(key, await host.seal(key, { type: 'host-info' }));
    expect(phone.takeHello()).toBe(true);
    expect(phone.takeHello()).toBe(false);
  });
});

function counterOf(frame: Uint8Array): number {
  return (frame[9] << 24) | (frame[10] << 16) | (frame[11] << 8) | frame[12];
}
