import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { CursorBridgeTool } from './execBridge';
import { attachCursorBridgeToSession, handlePiCursorExec } from './sessionBridge';

function fakeSession(prompt: () => Promise<void>) {
  return {
    subscribe() {
      return () => {};
    },
    prompt,
    steer: async () => {},
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recordingWrite(owner: string, calls: string[]): CursorBridgeTool {
  return {
    name: 'write',
    execute: async (_id, args) => {
      calls.push(`${owner}:${String(args.path)}`);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

/** 模拟 pi-cursor 收到一帧 writeArgs 后调用钩子；钩子不接管时返回 false */
function writeExec(path: string): Promise<boolean> {
  return Promise.resolve(
    handlePiCursorExec(
      'writeArgs',
      { id: 1, execId: path, message: { value: { path, fileText: 'x', toolCallId: path } } },
      () => {}
    )
  );
}

describe('Cursor 会话桥多会话并发', () => {
  // 背景：所有会话共用一个 worker；旧实现在 prompt 期间改写模块级变量，轮次重叠时 A 的写盘派给了 B
  it('两个 Cursor 会话轮次重叠时，各自的 exec 帧派给各自会话的工具', async () => {
    const calls: string[] = [];
    const aTurn = deferred();
    const bTurn = deferred();
    const a = fakeSession(async () => {
      await aTurn.promise;
      await writeExec('a.md');
    });
    const b = fakeSession(async () => {
      await bTurn.promise;
      await writeExec('b.md');
    });
    attachCursorBridgeToSession(a as never, [recordingWrite('A', calls)], '/a');
    attachCursorBridgeToSession(b as never, [recordingWrite('B', calls)], '/b');

    const runA = a.prompt();
    const runB = b.prompt();
    // A 的帧在 B 的轮次进行中到达，B 的帧在 A 的轮次结束后到达
    aTurn.resolve();
    await runA;
    bTurn.resolve();
    await runB;

    expect(calls).toEqual(['A:a.md', 'B:b.md']);
  });

  // 背景：pi-cursor 在每次 streamSimple 里用进程内 HTTP/2 开流（连接可能在会话外建好并复用），
  // exec 帧经流的 data 回调到达；派发正确依赖流回调沿用开流时的异步上下文
  it('exec 帧经 HTTP/2 流回调到达时，连接在会话外建立也派给开流的会话', async () => {
    const server = http2.createServer();
    const pushers = new Map<string, () => void>();
    const bothOpened = deferred();
    server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
      stream.respond({ ':status': 200 });
      pushers.set(String(headers[':path']), () => stream.end('exec'));
      if (pushers.size === 2) bothOpened.resolve();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const client = http2.connect(`http://127.0.0.1:${port}`);
    try {
      const calls: string[] = [];
      // 每个会话在自己的轮次里开流，收到服务端推来的一帧 exec 处理完才结束本轮
      const streamingSession = (name: string) =>
        fakeSession(
          () =>
            new Promise<void>((resolve, reject) => {
              const request = client.request({ ':path': `/${name}` });
              request.on('data', () => {
                writeExec(`${name}.md`).then(() => resolve(), reject);
              });
              request.on('error', reject);
              request.end();
            })
        );
      const a = streamingSession('a');
      const b = streamingSession('b');
      attachCursorBridgeToSession(a as never, [recordingWrite('A', calls)], '/a');
      attachCursorBridgeToSession(b as never, [recordingWrite('B', calls)], '/b');

      const runA = a.prompt();
      const runB = b.prompt();
      await bothOpened.promise;
      pushers.get('/a')?.();
      await runA;
      pushers.get('/b')?.();
      await runB;

      expect(calls).toEqual(['A:a.md', 'B:b.md']);
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
