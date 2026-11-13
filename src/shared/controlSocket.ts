import type { Socket } from 'node:net';
import { createInterface } from 'node:readline';

/** 本机控制 socket 上的一个连接：每行一条命令，处理完回一行 JSON 并关闭写端 */
export function serveControlConnection(
  socket: Socket,
  handle: (line: string) => Promise<unknown>
): void {
  // 客户端可能等不及长命令（update 要等 npm cache add）先 Ctrl-C 断开：回包写到已断开的
  // socket 报 EPIPE，没人接住就是未捕获异常，整个宿主跟着退出
  socket.on('error', () => socket.destroy());
  const lines = createInterface({ input: socket });
  // readline 会把 socket 的 error 转发到自己身上，这里同样要接住
  lines.on('error', () => {});
  lines.on('line', (line) => {
    void handle(line)
      .catch((error: unknown) => ({ ok: false, error: String(error) }))
      .then((reply) => {
        // 已断开或已经回过包（同一连接发了多行）时写端已关，不再写
        if (socket.writable) socket.end(`${JSON.stringify(reply)}\n`);
      });
  });
}
