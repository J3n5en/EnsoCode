import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch } from 'undici';
import { afterEach, expect, it, vi } from 'vitest';
import { imageDownloadDispatcher } from './downloadDispatcher';

afterEach(() => vi.unstubAllEnvs());

it('代理隧道连接校验过的 IP，目标 HTTP Host 仍为原域名', async () => {
  const targets: string[] = [];
  const requests: string[] = [];
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    targets.push(request.url ?? '');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', (data) => {
      requests.push(data.toString());
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
  vi.stubEnv('HTTPS_PROXY', '');
  vi.stubEnv('NO_PROXY', '');
  const url = new URL('http://unresolvable-image.example/image');
  const dispatcher = imageDownloadDispatcher(url, ['8.8.8.8']);
  try {
    const response = await fetch(url, { dispatcher, signal: AbortSignal.timeout(3000) }).catch(
      (error: Error) => {
        throw error.cause ?? error;
      }
    );
    expect(await response.text()).toBe('ok');
    expect(targets).toEqual(['8.8.8.8:80']);
    expect(requests[0].toLowerCase()).toContain('host: unresolvable-image.example');
  } finally {
    await dispatcher.destroy();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

it('直连使用固定的已校验地址，不重新解析原域名', async () => {
  const server = createServer((request, response) => {
    response.end(request.headers.host);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('HTTP_PROXY', '');
  vi.stubEnv('http_proxy', '');
  const url = new URL(
    `http://unresolvable-image.example:${(server.address() as AddressInfo).port}/image`
  );
  // 调用方负责公网校验；此处用本机 fixture 验证 DNS pin 的真实连接行为。
  const dispatcher = imageDownloadDispatcher(url, ['127.0.0.1']);
  try {
    const response = await fetch(url, { dispatcher, signal: AbortSignal.timeout(3000) }).catch(
      (error: Error) => {
        throw error.cause ?? error;
      }
    );
    expect(await response.text()).toBe(url.host);
  } finally {
    await dispatcher.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
