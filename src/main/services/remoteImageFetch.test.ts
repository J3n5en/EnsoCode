import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchRemoteImageDataUrl } from './remoteImageFetch';

let server: Server | null = null;
afterEach(async () => {
  if (!server) return;
  await new Promise((resolve) => server?.close(resolve));
  server = null;
});

function listen(
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse
  ) => void
): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('fetchRemoteImageDataUrl', () => {
  it('URL 本身就是内网字面量 IP：直接拒绝，不发起连接', async () => {
    const port = await listen((_req, res) => res.end('should not reach'));
    const result = await fetchRemoteImageDataUrl(`http://127.0.0.1:${port}/a.png`);
    expect(result).toEqual({ ok: false, error: 'blocked-address' });
  });

  it('DNS rebinding：域名解析出内网 IP 时拒绝，即便 URL 本身用的是「看起来公网」的主机名', async () => {
    const port = await listen((_req, res) => res.end('should not reach'));
    const result = await fetchRemoteImageDataUrl('https://images.example.com/badge.png', {
      isAllowedUrl: () => true, // 绕开字符串层校验，专测「解析出的 IP 再判一次」这条防线
      resolveHost: async () => '127.0.0.1',
    });
    void port;
    expect(result).toEqual({ ok: false, error: 'blocked-address' });
  });

  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('放行地址下载真实位图，返回正确 mime 的 data URL', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_MAGIC);
    });
    const result = await fetchRemoteImageDataUrl(`http://127.0.0.1:${port}/a.png`, {
      isAllowedUrl: () => true,
      isAllowedAddress: () => true,
      resolveHost: async () => '127.0.0.1',
    });
    expect(result).toEqual({
      ok: true,
      dataUrl: `data:image/png;base64,${PNG_MAGIC.toString('base64')}`,
    });
  });

  it('服务器声明 Content-Type 为位图但实际内容是 SVG/HTML 时拒绝（不信任服务器自报）', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end('<svg onload="alert(1)"></svg>');
    });
    const result = await fetchRemoteImageDataUrl(`http://127.0.0.1:${port}/fake.png`, {
      isAllowedUrl: () => true,
      isAllowedAddress: () => true,
      resolveHost: async () => '127.0.0.1',
    });
    expect(result).toEqual({ ok: false, error: 'unsupported' });
  });

  it('拒绝非位图 Content-Type（防止把任意响应当图片塞进 DOM）', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    });
    const result = await fetchRemoteImageDataUrl(`http://127.0.0.1:${port}/a.png`, {
      isAllowedUrl: () => true,
      isAllowedAddress: () => true,
      resolveHost: async () => '127.0.0.1',
    });
    expect(result).toEqual({ ok: false, error: 'unsupported' });
  });

  it('svg 徽章类内容（README badge 常见形态）声明与实际都是 image/svg+xml 时放行', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    });
    const result = await fetchRemoteImageDataUrl(`http://127.0.0.1:${port}/badge.svg`, {
      isAllowedUrl: () => true,
      isAllowedAddress: () => true,
      resolveHost: async () => '127.0.0.1',
    });
    expect(result).toEqual({
      ok: true,
      dataUrl: `data:image/svg+xml;base64,${Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
      ).toString('base64')}`,
    });
  });

  it('超过大小上限拒绝', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.alloc(20));
    });
    const result = await fetchRemoteImageDataUrl(`http://127.0.0.1:${port}/a.png`, {
      isAllowedUrl: () => true,
      isAllowedAddress: () => true,
      resolveHost: async () => '127.0.0.1',
      maxBytes: 10,
    });
    expect(result).toEqual({ ok: false, error: 'too-large' });
  });

  it('重定向到内网地址时中止，不跟随', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/internal.png' });
      res.end();
    });
    const result = await fetchRemoteImageDataUrl(`http://127.0.0.1:${port}/a.png`, {
      isAllowedUrl: (u) => u.includes(`:${port}/`), // 只放行首跳，重定向目标仍会被字面量 IP 判断拦下
      isAllowedAddress: () => true,
      resolveHost: async () => '127.0.0.1',
    });
    expect(result).toEqual({ ok: false, error: 'blocked-address' });
  });
});
