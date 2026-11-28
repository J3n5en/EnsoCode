import { describe, expect, it } from 'vitest';
import { parseRemoteCommand } from './commands';

describe('parseRemoteCommand', () => {
  it('accepts well-formed frames and strips unknown fields', () => {
    expect(
      parseRemoteCommand({
        type: 'rpc-invoke',
        cid: 'c-1',
        id: 3,
        ch: 'files:read',
        args: [1],
        x: 1,
      })
    ).toEqual({
      ok: true,
      command: { type: 'rpc-invoke', cid: 'c-1', id: 3, ch: 'files:read', args: [1] },
    });
    expect(parseRemoteCommand({ type: 'rpc-hello', cid: 'abc', kind: 'main' }).ok).toBe(true);
    expect(parseRemoteCommand({ type: 'asset-get', id: 0, path: 'r/index.html' }).ok).toBe(true);
  });

  it('keeps resume position and send ids for replay/dedupe', () => {
    expect(parseRemoteCommand({ type: 'rpc-hello', cid: 'c', kind: 'main', seq: 7 })).toEqual({
      ok: true,
      command: { type: 'rpc-hello', cid: 'c', kind: 'main', seq: 7 },
    });
    expect(parseRemoteCommand({ type: 'rpc-send', cid: 'c', id: 9, ch: 'x', args: [] })).toEqual({
      ok: true,
      command: { type: 'rpc-send', cid: 'c', id: 9, ch: 'x', args: [] },
    });
    expect(
      parseRemoteCommand({ type: 'rpc-hello', cid: 'c', kind: 'main', seq: 0, page: 'p-1' })
    ).toEqual({
      ok: true,
      command: { type: 'rpc-hello', cid: 'c', kind: 'main', seq: 0, page: 'p-1' },
    });
    expect(parseRemoteCommand({ type: 'rpc-hello', cid: 'c', kind: 'main', page: 'a b' }).ok).toBe(
      false
    );
    expect(parseRemoteCommand({ type: 'rpc-hello', cid: 'c', kind: 'main', seq: -1 }).ok).toBe(
      false
    );
    expect(parseRemoteCommand({ type: 'rpc-send', cid: 'c', id: 'x', ch: 'x', args: [] }).ok).toBe(
      false
    );
  });

  it('accepts receive progress for flow control', () => {
    expect(parseRemoteCommand({ type: 'remote-ack', bytes: 4096 })).toEqual({
      ok: true,
      command: { type: 'remote-ack', bytes: 4096 },
    });
    expect(parseRemoteCommand({ type: 'remote-ack', bytes: 0, gzip: true })).toEqual({
      ok: true,
      command: { type: 'remote-ack', bytes: 0, gzip: true },
    });
    expect(parseRemoteCommand({ type: 'remote-ack', bytes: 0, gzip: true, v2: true })).toEqual({
      ok: true,
      command: { type: 'remote-ack', bytes: 0, gzip: true, v2: true },
    });
    expect(parseRemoteCommand({ type: 'remote-ack', bytes: 0, v2: 'yes' })).toEqual({
      ok: true,
      command: { type: 'remote-ack', bytes: 0 },
    });
    expect(parseRemoteCommand({ type: 'remote-ack', bytes: -1 }).ok).toBe(false);
    expect(parseRemoteCommand({ type: 'remote-ack', bytes: 1.5 }).ok).toBe(false);
  });

  it('rejects malformed frames', () => {
    for (const bad of [
      { type: 'rpc-hello', cid: 'a b', kind: 'main' },
      { type: 'rpc-hello', cid: 'a', kind: 'other' },
      { type: 'rpc-hello', cid: 'a', kind: 'settings' },
      { type: 'rpc-invoke', cid: 'a', id: -1, ch: 'x', args: [] },
      { type: 'rpc-invoke', cid: 'a', id: 1, ch: 'x', args: {} },
      { type: 'rpc-send', cid: 'a', ch: 'bad channel', args: [] },
      { type: 'asset-get', id: 1 },
    ]) {
      expect(parseRemoteCommand(bad).ok).toBe(false);
    }
  });

  it('validates rpc-hello prefetch entries and caps length', () => {
    expect(
      parseRemoteCommand({
        type: 'rpc-hello',
        cid: 'c',
        kind: 'main',
        prefetch: [{ ch: 'settings:read', args: [], h: 'abc', extra: 1 }],
      })
    ).toEqual({
      ok: true,
      command: {
        type: 'rpc-hello',
        cid: 'c',
        kind: 'main',
        prefetch: [{ ch: 'settings:read', args: [], h: 'abc' }],
      },
    });
    expect(
      parseRemoteCommand({
        type: 'rpc-hello',
        cid: 'c',
        kind: 'main',
        prefetch: 'bad',
      }).ok
    ).toBe(false);
    expect(
      parseRemoteCommand({
        type: 'rpc-hello',
        cid: 'c',
        kind: 'main',
        prefetch: Array.from({ length: 17 }, (_, i) => ({
          ch: 'settings:read',
          args: [i],
          h: 'h',
        })),
      }).ok
    ).toBe(false);
    expect(
      parseRemoteCommand({
        type: 'rpc-hello',
        cid: 'c',
        kind: 'main',
        prefetch: [{ ch: 'bad channel', args: [], h: 'h' }],
      }).ok
    ).toBe(false);
    expect(
      parseRemoteCommand({
        type: 'rpc-hello',
        cid: 'c',
        kind: 'main',
        prefetch: [{ ch: 'settings:read', args: {}, h: 'h' }],
      }).ok
    ).toBe(false);
    expect(
      parseRemoteCommand({
        type: 'rpc-hello',
        cid: 'c',
        kind: 'main',
        prefetch: [{ ch: 'settings:read', args: [], h: 'x'.repeat(65) }],
      }).ok
    ).toBe(false);
  });
});
