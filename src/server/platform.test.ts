import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(tmpdir(), 'enso-server-platform-'));
process.env.ENSO_DATA_DIR = dataDir;

const platform = await import('./platform');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('server platform', () => {
  it('round-trips secrets with a 0600 key file and rejects tampering', async () => {
    const encrypted = await platform.safeStorage.encryptStringAsync('pair-token');
    expect(await platform.safeStorage.decryptStringAsync(encrypted)).toEqual({
      result: 'pair-token',
      shouldReEncrypt: false,
    });
    const keyFile = path.join(dataDir, 'secret.key');
    expect(readFileSync(keyFile)).toHaveLength(32);
    expect(readFileSync(keyFile).toString('hex')).not.toContain('pair-token');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    encrypted[encrypted.length - 1] ^= 0xff;
    await expect(platform.safeStorage.decryptStringAsync(encrypted)).rejects.toThrow();
  });

  it('keeps ipc handlers and listeners independently removable', () => {
    const seen: string[] = [];
    const listener = () => seen.push('a');
    platform.ipcMain.on('demo', listener);
    platform.ipcMain.handle('demo', () => 'ok');
    platform.ipcMain.off('demo', listener);
    platform.ipcMain.removeHandler('demo');
    platform.ipcMain.removeAllListeners('demo');
    expect(seen).toEqual([]);
  });

  it('forks a worker that answers after spawn', async () => {
    const script = path.join(dataDir, 'worker.mjs');
    writeFileSync(
      script,
      `process.on('message', (message) => { process.send({ echo: message }); });\n`
    );
    const worker = platform.utilityProcess.fork(script, [], {
      serviceName: 'test-worker',
      env: { ...process.env },
    });
    await new Promise<void>((resolve) => worker.once('spawn', () => resolve()));
    const echoed = new Promise<unknown>((resolve) => worker.once('message', resolve));
    worker.postMessage({ n: 1 });
    expect(await echoed).toEqual({ echo: { n: 1 } });
    worker.kill();
  });

  it('分区会话按 setProxy 规则真实生效：direct 直连，proxyRules 经该代理', async () => {
    const listen = (server: Server) =>
      new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      );
    const target = createServer((_req, res) => res.end('ok'));
    const hits: string[] = [];
    const proxy = createServer((req, res) => {
      const url = new URL(req.url ?? '');
      hits.push(url.host);
      request(url, { headers: req.headers }, (reply) => reply.pipe(res)).end();
    });
    const targetUrl = `http://127.0.0.1:${await listen(target)}/`;
    const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
    try {
      const direct = platform.session.fromPartition('enso-provider-proxy:direct');
      await direct.setProxy({ mode: 'direct' });
      expect(await (await direct.fetch(targetUrl)).text()).toBe('ok');
      expect(hits).toEqual([]);

      const custom = platform.session.fromPartition('enso-provider-proxy:custom-test');
      expect(platform.session.fromPartition('enso-provider-proxy:custom-test')).toBe(custom);
      await custom.setProxy({ proxyRules: proxyUrl });
      expect(await (await custom.fetch(targetUrl)).text()).toBe('ok');
      expect(hits).toEqual([new URL(targetUrl).host]);
    } finally {
      for (const server of [target, proxy]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });
});

// settings.json 里有供应商 API key、MCP env；数据目录放开读权限，本机其他用户就能读到
describe.skipIf(process.platform === 'win32')('server data dir permissions', () => {
  afterEach(() => {
    process.env.ENSO_DATA_DIR = dataDir;
  });

  it('新建的数据目录只给本人访问（0700）', () => {
    const fresh = path.join(dataDir, 'fresh', 'data');
    process.env.ENSO_DATA_DIR = fresh;
    expect(platform.app.getPath('userData')).toBe(fresh);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
  });

  it('旧版本建成 0755 的数据目录，启动时收紧为 0700', () => {
    const legacy = path.join(dataDir, 'legacy');
    mkdirSync(legacy);
    chmodSync(legacy, 0o755);
    process.env.ENSO_DATA_DIR = legacy;
    platform.app.getPath('userData');
    expect(statSync(legacy).mode & 0o777).toBe(0o700);
  });
});
