import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type ArchiveFetch, downloadPluginArchive, parsePluginInstallUrl } from './download';

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-url-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function body(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('parsePluginInstallUrl', () => {
  it('接受 http 与 https，并去掉首尾空白', () => {
    expect(parsePluginInstallUrl(' https://example.com/a.zip ').ok).toBe(true);
    expect(parsePluginInstallUrl('http://127.0.0.1:8080/plugin.zip').ok).toBe(true);
  });

  it('拒绝非 http(s)、账号密码、空主机和过长链接', () => {
    for (const input of [
      '',
      'not a url',
      'file:///tmp/a.zip',
      'ftp://example.com/a.zip',
      'javascript:alert(1)',
      'https://user:secret@example.com/a.zip',
      'http://',
      `https://example.com/${'a'.repeat(2100)}`,
    ]) {
      expect(parsePluginInstallUrl(input).ok).toBe(false);
    }
  });
});

describe('downloadPluginArchive', () => {
  it('跟随 http(s) 重定向并把内容写到目标文件', async () => {
    const dest = join(temp(), 'plugin.zip');
    const seen: string[] = [];
    const fetchImpl: ArchiveFetch = async (url) => {
      seen.push(url);
      if (url === 'https://example.com/start') {
        return {
          status: 302,
          headers: { get: (name) => (name === 'location' ? '/files/plugin.zip' : null) },
          body: null,
        };
      }
      return { status: 200, headers: { get: () => null }, body: body(Buffer.from('zip-bytes')) };
    };
    await downloadPluginArchive(new URL('https://example.com/start'), dest, {
      fetch: fetchImpl,
      maxBytes: 100,
    });
    expect(seen).toEqual(['https://example.com/start', 'https://example.com/files/plugin.zip']);
    expect(readFileSync(dest, 'utf8')).toBe('zip-bytes');
  });

  it('拒绝跳到非 http(s)，不留下文件', async () => {
    const dest = join(temp(), 'plugin.zip');
    const fetchImpl: ArchiveFetch = async () => ({
      status: 302,
      headers: { get: (name) => (name === 'location' ? 'file:///etc/passwd' : null) },
      body: null,
    });
    await expect(
      downloadPluginArchive(new URL('https://example.com/a.zip'), dest, {
        fetch: fetchImpl,
        maxBytes: 100,
      })
    ).rejects.toThrow(/重定向/);
    expect(() => readFileSync(dest)).toThrow();
  });

  it('HTTP 错误、声明过大、正文过大、重定向过多都失败且不留文件', async () => {
    const root = temp();
    const tooBigHeader = join(root, 'header.zip');
    let headerRead = false;
    await expect(
      downloadPluginArchive(new URL('https://example.com/a.zip'), tooBigHeader, {
        fetch: async () => ({
          status: 200,
          headers: { get: (name) => (name === 'content-length' ? '999' : null) },
          body: {
            getReader: () => {
              headerRead = true;
              throw new Error('should not read');
            },
          } as unknown as ReadableStream<Uint8Array>,
        }),
        maxBytes: 10,
      })
    ).rejects.toThrow(/过大/);
    expect(headerRead).toBe(false);

    const tooBigBody = join(root, 'body.zip');
    await expect(
      downloadPluginArchive(new URL('https://example.com/a.zip'), tooBigBody, {
        fetch: async () => ({
          status: 200,
          headers: { get: () => null },
          body: body(Buffer.alloc(11)),
        }),
        maxBytes: 10,
      })
    ).rejects.toThrow(/过大/);

    const missing = join(root, 'missing.zip');
    await expect(
      downloadPluginArchive(new URL('https://example.com/a.zip'), missing, {
        fetch: async () => ({ status: 404, headers: { get: () => null }, body: null }),
        maxBytes: 10,
      })
    ).rejects.toThrow(/404/);

    const loop = join(root, 'loop.zip');
    await expect(
      downloadPluginArchive(new URL('https://example.com/a.zip'), loop, {
        fetch: async () => ({
          status: 302,
          headers: { get: (name) => (name === 'location' ? 'https://example.com/a.zip' : null) },
          body: null,
        }),
        maxBytes: 10,
      })
    ).rejects.toThrow(/重定向过多/);
    for (const path of [tooBigHeader, tooBigBody, missing, loop]) {
      expect(() => readFileSync(path)).toThrow();
    }
  });

  it('超时时失败', async () => {
    const dest = join(temp(), 'plugin.zip');
    const fetchImpl: ArchiveFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    await expect(
      downloadPluginArchive(new URL('https://example.com/a.zip'), dest, {
        fetch: fetchImpl,
        maxBytes: 10,
        timeoutMs: 20,
      })
    ).rejects.toThrow(/超时/);
  });
});
