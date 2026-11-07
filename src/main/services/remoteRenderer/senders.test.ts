import { decodeRemoteValue, type HostToRemote } from '@enso/pair';
import { UPSERT_MARK, UpsertDecoder } from '@shared/remoteDelta';
import { SNAPSHOT_TAIL_MESSAGES } from '@shared/snapshotTail';
import { describe, expect, it, vi } from 'vitest';
import {
  addRemoteSender,
  RemoteSender,
  remoteLeaderId,
  remoteSenders,
  SETTINGS_COALESCE_MS,
  STREAM_COALESCE_MS,
  staleRemoteSenders,
} from './senders';

const seqs = (frames: HostToRemote[]) => frames.map((frame) => (frame as { seq?: number }).seq);

function setup(limits?: { maxFrames?: number; maxBytes?: number }) {
  const first: HostToRemote[] = [];
  const sender = new RemoteSender('pair', 'cid', 'main', (frame) => first.push(frame), limits);
  return { sender, first };
}

describe('RemoteSender seq replay', () => {
  it('numbers every frame so the browser can apply them in order', () => {
    const { sender, first } = setup();
    sender.send('a');
    sender.post({ type: 'rpc-result', cid: 'cid', id: 1, ok: true, data: null });
    expect(seqs(first)).toEqual([1, 2]);
  });

  it('replays frames lost on a link the host still thought was alive', () => {
    const { sender } = setup();
    sender.send('a');
    sender.send('b');
    sender.send('c');
    const next: HostToRemote[] = [];
    // 浏览器只收到了 seq 1，其余落进了已死的链路
    expect(sender.resume((frame) => next.push(frame), 1)).toBe(true);
    expect(seqs(next)).toEqual([2, 3]);
  });

  it('keeps buffering while suspended and replays after the browser position', () => {
    const { sender, first } = setup();
    sender.send('a');
    sender.suspend();
    sender.send('b');
    expect(seqs(first)).toEqual([1]);
    const next: HostToRemote[] = [];
    expect(sender.resume((frame) => next.push(frame), 1)).toBe(true);
    expect(seqs(next)).toEqual([2]);
  });

  it('old browsers without seq still get what was buffered while suspended', () => {
    const { sender } = setup();
    sender.send('a');
    sender.suspend();
    sender.send('b');
    const next: HostToRemote[] = [];
    expect(sender.resume((frame) => next.push(frame))).toBe(true);
    expect(seqs(next)).toEqual([2]);
  });

  it('cannot resume once frames the browser needs were evicted', () => {
    const { sender } = setup({ maxFrames: 2 });
    for (const ch of ['a', 'b', 'c']) sender.send(ch);
    expect(sender.resume(() => {}, 0)).toBe(false);
    expect(sender.resume(() => {}, 1)).toBe(true);
  });

  it('evicts by size too', () => {
    const { sender } = setup({ maxBytes: 200 });
    sender.send('x', 'a'.repeat(150));
    sender.send('y', 'b'.repeat(150));
    expect(sender.resume(() => {}, 0)).toBe(false);
    expect(sender.resume(() => {}, 1)).toBe(true);
  });

  it('rejects a browser that claims frames the host never sent', () => {
    const { sender } = setup();
    sender.send('a');
    expect(sender.resume(() => {}, 5)).toBe(false);
  });
});

describe('RemoteSender request dedupe', () => {
  it('accepts each request id once so resent invokes do not run twice', () => {
    const { sender } = setup();
    expect(sender.accept(1)).toBe(true);
    expect(sender.accept(1)).toBe(false);
    expect(sender.accept(2)).toBe(true);
    expect(sender.accept(undefined)).toBe(true);
    expect(sender.accept(undefined)).toBe(true);
  });
});

describe('staleRemoteSenders', () => {
  it('finds renderers left behind by an earlier page of the same device', () => {
    const make = (pairId: string, cid: string, page?: string) => {
      const sender = new RemoteSender(pairId, cid, 'main', () => {});
      sender.page = page;
      addRemoteSender(sender);
      return sender;
    };
    const old = make('stale-pair', 'old', 'page-1');
    const current = make('stale-pair', 'cur', 'page-2');
    const legacy = make('stale-pair', 'legacy');
    const other = make('stale-other', 'x', 'page-1');
    // 中继每个配对只容一个手机连接：新页面接入后，旧页面的 renderer 不可能还活着
    expect(staleRemoteSenders('stale-pair', 'page-2')).toEqual([old]);
    expect(staleRemoteSenders('stale-pair', undefined)).toEqual([]);
    for (const sender of [old, current, legacy, other]) sender.destroy();
  });
});

describe('RemoteSender streaming coalesce', () => {
  const upsert = (index: number, seq: number, text: string) => ({
    type: 'message-upsert',
    identity: { sessionId: 's1', generation: 'g1' },
    seq,
    index,
    message: { text },
  });
  const events = (frames: HostToRemote[]) =>
    frames.map((frame) => {
      const [event] = decodeRemoteValue<[{ type: string; seq: number }]>(
        (frame as { args: unknown }).args
      );
      return `${event.type}#${event.seq}`;
    });

  it('keeps only the latest body per streaming message and flushes before other events', () => {
    vi.useFakeTimers();
    try {
      const { sender, first } = setup();
      sender.send('agent:event', upsert(0, 1, 'a'));
      sender.send('agent:event', upsert(1, 2, 'b'));
      sender.send('agent:event', upsert(0, 3, 'ab'));
      expect(first).toHaveLength(0);
      // 其它事件不能越过尚未发出的正文：先冲刷，per-session seq 仍递增
      sender.send('agent:event', { type: 'status', identity: { sessionId: 's1' }, seq: 4 });
      expect(events(first)).toEqual(['message-upsert#2', 'message-upsert#3', 'status#4']);

      sender.send('agent:event', upsert(1, 5, 'bc'));
      sender.send('agent:event', upsert(1, 6, 'bcd'));
      vi.advanceTimersByTime(STREAM_COALESCE_MS);
      expect(events(first).slice(3)).toEqual(['message-upsert#6']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('later frames of the same message carry only the delta; the browser rebuilds the body', () => {
    vi.useFakeTimers();
    try {
      const { sender, first } = setup();
      const head = 'streamed text '.repeat(30);
      for (const [seq, text] of [
        [1, head],
        [2, `${head}more`],
        [3, `${head}more!`],
      ] as const) {
        sender.send('agent:event', upsert(0, seq, text));
        vi.advanceTimersByTime(STREAM_COALESCE_MS);
      }
      const raw = first.map((f) => (f as { args: Record<string, unknown>[] }).args[0]);
      expect(raw[0]?.message).toEqual({ text: head });
      expect(raw[2]?.message).toBeUndefined();
      expect(JSON.stringify(raw[2]).length).toBeLessThan(300);
      const decoder = new UpsertDecoder();
      expect(raw.map((e) => decoder.decode(e?.[UPSERT_MARK], e?.message))).toEqual([
        { text: head },
        { text: `${head}more` },
        { text: `${head}more!` },
      ]);

      // 浏览器丢了基线：reset 后下一帧整条
      sender.resetUpserts();
      sender.send('agent:event', upsert(0, 4, `${head}more!?`));
      vi.advanceTimersByTime(STREAM_COALESCE_MS);
      const last = (first.at(-1) as { args: Record<string, unknown>[] }).args[0];
      expect(new UpsertDecoder().decode(last?.[UPSERT_MARK], last?.message)).toEqual({
        text: `${head}more!?`,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RemoteSender snapshot trimming', () => {
  const message = (i: number) => ({ role: 'user', content: `m${i} ${'x'.repeat(50)}` });
  const snapshot = (count: number, extra: Record<string, unknown> = {}) => ({
    type: 'snapshot',
    partial: true,
    sessionId: 's1',
    sessions: [
      {
        identity: { sessionId: 's1' },
        status: 'idle',
        messages: Array.from({ length: count }, (_, i) => message(i)),
        commands: [],
      },
    ],
    ...extra,
  });
  const delivered = (frames: HostToRemote[]) =>
    frames.map(
      (frame) =>
        decodeRemoteValue<
          [{ sessions: { baseIndex?: number; messages: { content: string }[] }[] }]
        >((frame as { args: unknown }).args)[0]
    );

  it('sends only the recent tail of long histories; older pages load on scroll', () => {
    const { sender, first } = setup();
    sender.send('agent:event', snapshot(SNAPSHOT_TAIL_MESSAGES + 40));
    const [event] = delivered(first);
    const session = event?.sessions[0];
    expect(session?.baseIndex).toBe(40);
    expect(session?.messages).toHaveLength(SNAPSHOT_TAIL_MESSAGES);
    expect(session?.messages[0]?.content.startsWith('m40 ')).toBe(true);
  });

  it('keeps plugin-injected custom messages and their source in the tail and message upserts', () => {
    const { sender, first } = setup();
    const injected = {
      role: 'custom',
      content: [{ type: 'text', text: 'hello there' }],
      pluginSource: { pluginId: 'test.notify', pluginName: 'Notifier' },
    };
    const base = snapshot(SNAPSHOT_TAIL_MESSAGES + 3);
    base.sessions[0]?.messages.push(injected as never);
    sender.send('agent:event', base);
    const [event] = delivered(first);
    expect(event?.sessions[0]?.messages.at(-1)).toEqual(injected);
    sender.send('agent:event', {
      type: 'message-upsert',
      identity: { sessionId: 's1' },
      seq: 9,
      index: 5,
      message: injected,
    });
    sender.send('agent:event', { type: 'status', identity: { sessionId: 's1' }, seq: 10 });
    const upsert = decodeRemoteValue<[{ message: unknown }]>(
      (first.at(-2) as { args: unknown }).args
    )[0];
    expect(upsert?.message).toEqual(injected);
  });

  it('skips the deferred full resume snapshot when its tail matches the one just sent', () => {
    const { sender, first } = setup();
    const full = snapshot(SNAPSHOT_TAIL_MESSAGES + 40, { resumeFull: true });
    const tail = structuredClone(full);
    delete (tail as { resumeFull?: boolean }).resumeFull;
    // worker 的尾窗：baseIndex 紧跟 messages，与裁剪全量后的字段顺序不同
    const { identity, status, messages, commands } = tail.sessions[0] as never as Record<
      string,
      unknown[]
    >;
    tail.sessions[0] = {
      identity,
      status,
      messages: messages.slice(40),
      baseIndex: 40,
      commands,
    } as never;
    sender.send('agent:event', tail);
    sender.send('agent:event', full);
    expect(first).toHaveLength(1);
  });

  it('skips it even when the worker tail window starts elsewhere (raw vs projected budget)', () => {
    const { sender, first } = setup();
    const full = snapshot(SNAPSHOT_TAIL_MESSAGES + 40, { resumeFull: true });
    const tail = structuredClone(full);
    delete (tail as { resumeFull?: boolean }).resumeFull;
    const s0 = tail.sessions[0] as { messages: unknown[]; baseIndex?: number };
    s0.messages = s0.messages.slice(70);
    s0.baseIndex = 70;
    sender.send('agent:event', tail);
    sender.send('agent:event', full);
    expect(first).toHaveLength(1);
  });

  it('still sends the full resume snapshot when it differs, and never dedupes ordinary snapshots', () => {
    const { sender, first } = setup();
    sender.send('agent:event', snapshot(10));
    sender.send('agent:event', snapshot(11, { resumeFull: true }));
    sender.send('agent:event', snapshot(11));
    sender.send('agent:event', snapshot(11));
    expect(first).toHaveLength(4);
  });
});

describe('RemoteSender settings change coalesce', () => {
  it('merges bursts of settings:changed: the renderer rereads the latest state anyway', () => {
    vi.useFakeTimers();
    try {
      const { sender, first } = setup();
      sender.send('settings:changed');
      sender.send('agent:event', { type: 'status', identity: { sessionId: 's1' }, seq: 1 });
      sender.send('settings:changed');
      sender.send('settings:changed');
      const channels = () => first.map((frame) => (frame as { ch?: string }).ch);
      expect(channels()).toEqual(['agent:event']);
      vi.advanceTimersByTime(SETTINGS_COALESCE_MS);
      expect(channels()).toEqual(['agent:event', 'settings:changed']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('remoteLeaderId', () => {
  it('桌面主窗口活着时不选远端，否则选最早接入的远端主界面', () => {
    for (const stale of remoteSenders()) stale.destroy();
    const settings = new RemoteSender('p1', 'c-settings', 'settings', () => {});
    const earlier = new RemoteSender('p1', 'c-earlier', 'main', () => {});
    const later = new RemoteSender('p1', 'c-later', 'main', () => {});
    addRemoteSender(settings);
    addRemoteSender(later);
    addRemoteSender(earlier);
    try {
      expect(remoteLeaderId(true)).toBeNull();
      expect(remoteLeaderId(false)).toBe(earlier.id);
      earlier.destroy();
      expect(remoteLeaderId(false)).toBe(later.id);
      later.destroy();
      expect(remoteLeaderId(false)).toBeNull();
    } finally {
      settings.destroy();
      later.destroy();
      earlier.destroy();
    }
  });
});
