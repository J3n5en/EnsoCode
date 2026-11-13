import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const restartAgentWorker = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./agentHost', () => ({ restartAgentWorker }));

import { CaCertConfig, checkCaCertFile, getCaCertConfig, resolveExtraCaCert } from './caCert';

const KEY = 'NODE_EXTRA_CA_CERTS';

describe('custom CA certificate', () => {
  let dir: string;
  let certA: string;
  let certB: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'enso-ca-'));
    certA = join(dir, 'a.pem');
    certB = join(dir, 'b.crt');
    writeFileSync(certA, 'pem-a');
    writeFileSync(certB, 'pem-b');
    restartAgentWorker.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('checkCaCertFile', () => {
    it('可读文件通过；相对路径、不存在、目录各返回对应错误', () => {
      expect(checkCaCertFile(certA)).toBeNull();
      expect(checkCaCertFile('a.pem')).toBe('not-absolute');
      expect(checkCaCertFile(join(dir, 'missing.pem'))).toBe('not-found');
      mkdirSync(join(dir, 'sub'));
      expect(checkCaCertFile(join(dir, 'sub'))).toBe('not-file');
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      '无读权限返回 not-readable',
      () => {
        chmodSync(certA, 0o000);
        expect(checkCaCertFile(certA)).toBe('not-readable');
        chmodSync(certA, 0o600);
      }
    );
  });

  describe('resolveExtraCaCert 优先级', () => {
    it('已有 env > 设置项 > shell 探测', () => {
      expect(resolveExtraCaCert({ inherited: '/env.pem', setting: certA, shell: certB })).toEqual({
        source: 'env',
        path: '/env.pem',
        settingPath: certA,
      });
      expect(resolveExtraCaCert({ setting: certA, shell: certB })).toMatchObject({
        source: 'setting',
        path: certA,
      });
      expect(resolveExtraCaCert({ setting: '', shell: certB })).toMatchObject({
        source: 'shell',
        path: certB,
      });
      expect(resolveExtraCaCert({ setting: '' })).toEqual({
        source: 'none',
        path: '',
        settingPath: '',
      });
    });

    it('设置项文件不可用：不生效、带错误，也不回落到 shell', () => {
      const missing = join(dir, 'missing.pem');
      expect(resolveExtraCaCert({ setting: missing, shell: certB })).toEqual({
        source: 'none',
        path: '',
        settingPath: missing,
        error: 'not-found',
      });
    });

    it('shell 探测到的文件不可读时忽略', () => {
      expect(resolveExtraCaCert({ setting: '', shell: join(dir, 'x.pem') }).source).toBe('none');
    });
  });

  describe('CaCertConfig', () => {
    it('启动：设置项写入 env；空设置时采用 shell 探测值', () => {
      const env: NodeJS.ProcessEnv = {};
      const config = new CaCertConfig(env, restartAgentWorker);
      config.initFromConfig(certA);
      expect(env[KEY]).toBe(certA);

      const env2: NodeJS.ProcessEnv = {};
      const config2 = new CaCertConfig(env2, restartAgentWorker);
      config2.initFromConfig('');
      config2.applyShellValue(certB);
      expect(env2[KEY]).toBe(certB);
      expect(config2.status().source).toBe('shell');
    });

    it('启动时已有 env 不被设置项或 shell 覆盖，热更新也不重启 worker', async () => {
      const env: NodeJS.ProcessEnv = { [KEY]: '/launchctl.pem' };
      const config = new CaCertConfig(env, restartAgentWorker);
      config.initFromConfig(certA);
      config.applyShellValue(certB);
      expect(env[KEY]).toBe('/launchctl.pem');
      await expect(config.setCustomPath(certB)).resolves.toMatchObject({ source: 'env' });
      expect(env[KEY]).toBe('/launchctl.pem');
      expect(restartAgentWorker).not.toHaveBeenCalled();
    });

    it('文件不存在：不设置 env 并返回错误', () => {
      const env: NodeJS.ProcessEnv = {};
      const status = new CaCertConfig(env, restartAgentWorker).initFromConfig(
        join(dir, 'missing.pem')
      );
      expect(status.error).toBe('not-found');
      expect(KEY in env).toBe(false);
    });

    it('设置变更后更新 env 并重启 worker；值未变化不重启', async () => {
      const env: NodeJS.ProcessEnv = {};
      const config = new CaCertConfig(env, restartAgentWorker);
      config.initFromConfig('');

      await config.setCustomPath(certA);
      expect(env[KEY]).toBe(certA);
      expect(restartAgentWorker).toHaveBeenCalledTimes(1);

      await config.setCustomPath(certA);
      expect(restartAgentWorker).toHaveBeenCalledTimes(1);

      await config.setCustomPath('');
      expect(KEY in env).toBe(false);
      expect(restartAgentWorker).toHaveBeenCalledTimes(2);
    });

    it('换成不可读路径：清掉旧 env 并重启 worker，返回错误', async () => {
      const env: NodeJS.ProcessEnv = {};
      const config = new CaCertConfig(env, restartAgentWorker);
      config.initFromConfig(certA);
      const status = await config.setCustomPath(join(dir, 'missing.pem'));
      expect(status.error).toBe('not-found');
      expect(KEY in env).toBe(false);
      expect(restartAgentWorker).toHaveBeenCalledTimes(1);
    });

    it('默认实例改 process.env 并调用 agentHost.restartAgentWorker', async () => {
      const previous = process.env[KEY];
      delete process.env[KEY];
      try {
        const config = getCaCertConfig();
        await config.setCustomPath(certA);
        expect(process.env[KEY]).toBe(certA);
        expect(restartAgentWorker).toHaveBeenCalledTimes(1);
        await config.setCustomPath('');
      } finally {
        if (previous === undefined) delete process.env[KEY];
        else process.env[KEY] = previous;
      }
    });
  });
});
