import { AGY_SIGNED_OUT_MESSAGE } from '@shared/agy/stdout';
import { describe, expect, it } from 'vitest';
import { AgyRpcError, createJsonRpcConnection } from './connection';

function pair() {
  const leftWrite: string[] = [];
  const rightWrite: string[] = [];
  const left = createJsonRpcConnection((line) => {
    leftWrite.push(line);
    right.push(line);
  });
  const right = createJsonRpcConnection((line) => {
    rightWrite.push(line);
    left.push(line);
  });
  return { left, right, leftWrite, rightWrite };
}

describe('createJsonRpcConnection', () => {
  it('answers a request and delivers a notification', async () => {
    const { left, right } = pair();
    const notes: unknown[] = [];
    right.setNotificationHandler((method, params) => notes.push({ method, params }));
    right.setRequestHandler(async (method, params) => {
      if (method === 'echo') return { heard: params };
      throw new AgyRpcError(-32601, 'missing');
    });
    left.notify('session/update', { text: 'hi' });
    await expect(left.request('echo', { n: 1 })).resolves.toEqual({ heard: { n: 1 } });
    expect(notes).toEqual([{ method: 'session/update', params: { text: 'hi' } }]);
  });

  it('keeps the agent error code', async () => {
    const { left, right } = pair();
    right.setRequestHandler(() => {
      throw new AgyRpcError(-32000, 'signed out');
    });
    await expect(left.request('session/new', {})).rejects.toMatchObject({
      code: -32000,
      message: 'signed out',
    });
  });

  it('settles an in-order request before the notifications that follow it on the wire', () => {
    const conn = createJsonRpcConnection(() => {});
    const seen: string[] = [];
    conn.setNotificationHandler((_method, params) =>
      seen.push(`note:${(params as { n: number }).n}`)
    );
    conn.requestInOrder('session/prompt', {}, (outcome) =>
      seen.push(`settled:${JSON.stringify(outcome)}`)
    );
    // 同一块 stdout 里：先是 prompt 的答复，再是两条 update
    conn.push(
      [
        '{"jsonrpc":"2.0","method":"session/update","params":{"n":1}}',
        '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}',
        '{"jsonrpc":"2.0","method":"session/update","params":{"n":2}}',
        '',
      ].join('\n')
    );
    expect(seen).toEqual(['note:1', 'settled:{"result":{"stopReason":"end_turn"}}', 'note:2']);
  });

  it('settles an in-order request with the error, or when the connection closes', () => {
    const conn = createJsonRpcConnection(() => {});
    const seen: unknown[] = [];
    conn.requestInOrder('a', {}, (outcome) => seen.push(outcome));
    conn.requestInOrder('b', {}, (outcome) => seen.push(outcome));
    conn.push('{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"boom"}}\n');
    conn.close();
    expect(seen).toEqual([
      { error: expect.objectContaining({ code: -32603, message: 'boom' }) },
      { error: expect.objectContaining({ message: 'connection closed' }) },
    ]);
  });

  it('rejects an aborted request without sending a second call', async () => {
    const { left, right, leftWrite } = pair();
    right.setRequestHandler(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = left.request('session/prompt', { sessionId: 's' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(leftWrite).toHaveLength(1);
  });

  it('kills a login banner as signed-out without keeping the URL', async () => {
    const faults: string[] = [];
    const conn = createJsonRpcConnection(() => {}, {
      onFault: (fault) => faults.push(fault),
    });
    const pending = conn.request('initialize', {});
    conn.push(
      'Open the following link to authenticate: https://accounts.google.com/o/oauth2?secret=1\n'
    );
    await expect(pending).rejects.toMatchObject({
      code: -32000,
      message: AGY_SIGNED_OUT_MESSAGE,
    });
    expect(faults).toEqual(['signed-out']);
    expect(JSON.stringify(faults) + AGY_SIGNED_OUT_MESSAGE).not.toContain('accounts.google.com');
  });
});
