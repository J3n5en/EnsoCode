import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

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
});
