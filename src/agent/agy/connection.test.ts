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

  it('rejects an aborted request without sending a second call', async () => {
    const { left, right, leftWrite } = pair();
    right.setRequestHandler(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = left.request('session/prompt', { sessionId: 's' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(leftWrite).toHaveLength(1);
  });
});
