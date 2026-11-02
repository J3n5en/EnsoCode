import type { HostToRemote, RemoteToHost } from '@enso/pair';
import { encodeBase64, splitRemoteFrame } from '@enso/pair';
import { describe, expect, it, vi } from 'vitest';
import { NodeRemoteTunnel } from './tunnel';

function setup() {
  const sent: RemoteToHost[] = [];
  const tunnel = new NodeRemoteTunnel((frame) => sent.push(frame));
  return { sent, tunnel };
}

const ready = (cid: string, resumed = false): HostToRemote => ({
  type: 'rpc-ready',
  cid,
  ok: true,
  resumed,
  version: 'v',
  platform: 'darwin',
  leader: false,
  replay: true,
});

describe('NodeRemoteTunnel', () => {
  it('上线后 hello，ready 前的 invoke 排队，结果按 id 回到调用方', async () => {
    const { sent, tunnel } = setup();
    const cid = tunnel.attach('settings', { onEvent() {}, onReset() {} });
    const result = tunnel.invoke(cid, 'settings:read', '[]');
    expect(sent).toEqual([]);
    tunnel.setOnline(true);
    expect(sent).toEqual([
      { type: 'remote-ack', bytes: 0, gzip: true },
      { type: 'rpc-hello', cid, kind: 'settings', seq: 0 },
    ]);
    tunnel.receive(ready(cid));
    const invoke = sent[2] as Extract<RemoteToHost, { type: 'rpc-invoke' }>;
    expect(invoke).toMatchObject({ type: 'rpc-invoke', cid, ch: 'settings:read', args: [] });
    tunnel.receive({ type: 'rpc-result', cid, id: invoke.id, ok: true, data: { a: 1 }, seq: 1 });
    await expect(result).resolves.toBe('{"a":1}');
  });

  it('事件按 seq 顺序派发，重复帧丢弃', () => {
    const { tunnel } = setup();
    const events: string[] = [];
    const cid = tunnel.attach('settings', {
      onEvent: (ch, p) => events.push(`${ch}${p}`),
      onReset() {},
    });
    tunnel.setOnline(true);
    tunnel.receive(ready(cid));
    tunnel.receive({ type: 'rpc-event', cid, ch: 'b', args: [2], seq: 2 });
    tunnel.receive({ type: 'rpc-event', cid, ch: 'a', args: [1], seq: 1 });
    tunnel.receive({ type: 'rpc-event', cid, ch: 'a', args: [1], seq: 1 });
    expect(events).toEqual(['a[1]', 'b[2]']);
  });

  it('续不上（resumed=false）则拒绝在途请求并通知重载', async () => {
    const { sent, tunnel } = setup();
    const onReset = vi.fn();
    const cid = tunnel.attach('settings', { onEvent() {}, onReset });
    tunnel.setOnline(true);
    tunnel.receive(ready(cid));
    const pending = tunnel.invoke(cid, 'x', '[]');
    tunnel.setOnline(false);
    tunnel.setOnline(true);
    tunnel.receive(ready(cid, false));
    await expect(pending).rejects.toThrow('remote-session-lost');
    expect(onReset).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toEqual({ type: 'rpc-bye', cid });
  });

  it('续上后重发未决 invoke', () => {
    const { sent, tunnel } = setup();
    const cid = tunnel.attach('settings', { onEvent() {}, onReset() {} });
    tunnel.setOnline(true);
    tunnel.receive(ready(cid));
    void tunnel.invoke(cid, 'x', '[]');
    const before = sent.length;
    tunnel.setOnline(true);
    tunnel.receive(ready(cid, true));
    expect(sent.slice(before).map((f) => f.type)).toEqual([
      'remote-ack',
      'rpc-hello',
      'rpc-invoke',
    ]);
  });

  it('资源：分片重组后按 id 返回，上线时补发在途请求', async () => {
    const { sent, tunnel } = setup();
    const asset = tunnel.fetchAsset('r/settings.html');
    expect(sent).toEqual([]);
    tunnel.setOnline(true);
    const req = sent[1] as Extract<RemoteToHost, { type: 'asset-get' }>;
    expect(req).toMatchObject({ type: 'asset-get', path: 'r/settings.html' });
    const frame: HostToRemote = {
      type: 'asset',
      id: req.id,
      status: 200,
      mime: 'text/html',
      data: encodeBase64(new TextEncoder().encode('x'.repeat(300))),
    };
    for (const part of splitRemoteFrame(frame, () => 'p1', 100))
      tunnel.receive(part as HostToRemote);
    const got = await asset;
    expect(got.status).toBe(200);
    expect(new TextDecoder().decode(got.body)).toBe('x'.repeat(300));
    // 分片字节已回报（每 128KB 一次，这里不足，只有上线那次）
    expect(sent.filter((f) => f.type === 'remote-ack')).toHaveLength(1);
  });

  it('宿主压缩的帧解开后照常派发', async () => {
    const { sent, tunnel } = setup();
    const asset = tunnel.fetchAsset('r/a.js');
    tunnel.setOnline(true);
    const req = sent[1] as Extract<RemoteToHost, { type: 'asset-get' }>;
    const body = encodeBase64(new TextEncoder().encode('hello'));
    const inner = JSON.stringify({
      type: 'asset',
      id: req.id,
      status: 200,
      mime: 'text/javascript',
      data: body,
    });
    const packed = await new Response(
      new Blob([inner]).stream().pipeThrough(new CompressionStream('gzip'))
    ).arrayBuffer();
    tunnel.receive({ type: 'gzip', data: encodeBase64(new Uint8Array(packed)) } as HostToRemote);
    expect(new TextDecoder().decode((await asset).body)).toBe('hello');
  });

  it('close 拒绝所有在途请求', async () => {
    const { tunnel } = setup();
    const cid = tunnel.attach('settings', { onEvent() {}, onReset() {} });
    const pending = tunnel.invoke(cid, 'x', '[]');
    const asset = tunnel.fetchAsset('meta');
    tunnel.close();
    await expect(pending).rejects.toThrow();
    await expect(asset).resolves.toMatchObject({ status: 503 });
  });
});
