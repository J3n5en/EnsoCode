/**
 * 真机 SSH E2E:仅当 SSH_E2E_HOST 存在时跑(CI 默认 skip)。
 * 约定远端目录由调用方准备好(git repo + hello.txt + AGENTS.md)。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { sshProbeDirectory } from '../../main/services/sshProbe';
import { createCheckpoint, listCheckpointRefs, restoreCheckpoint } from '../checkpoint/core';
import { createRemoteCheckpointHost } from '../checkpoint/remoteHost';
import { createSshExecutor } from './executor';
import { createRemoteGrepToolDefinition } from './remoteGrep';
import { createRemoteOperations } from './remoteOperations';

const host = process.env.SSH_E2E_HOST;
const cwd = process.env.SSH_E2E_PATH ?? '/root/enso-ssh-e2e';
const ctx = undefined as unknown as ExtensionContext;

describe.skipIf(!host)('ssh 真机 e2e', { timeout: 60_000 }, () => {
  const controlDir = join(tmpdir(), 'enso-ssh-e2e-cm');
  mkdirSync(controlDir, { recursive: true });
  const executor = createSshExecutor(host as string, controlDir);
  const ops = createRemoteOperations(executor);

  it('探测:有效目录通过,无效路径/不可达 host 返回可读错误', async () => {
    await expect(sshProbeDirectory(host as string, cwd)).resolves.toBeNull();
    await expect(sshProbeDirectory(host as string, '/definitely-not-a-dir-enso')).resolves.toMatch(
      /不存在|不是目录/
    );
    await expect(sshProbeDirectory('no-such-enso-host.invalid', cwd)).resolves.toMatch(/无法连接/);
  });

  it('read/ls/find/grep/bash/write/edit 作用在远端,本机路径不受影响', async () => {
    await ops.write.writeFile(`${cwd}/hello.txt`, 'remote-e2e-hello\n');
    const hello = await ops.read.readFile(`${cwd}/hello.txt`);
    expect(hello.toString('utf8')).toContain('remote-e2e-hello');
    expect(existsSync(join('/root/enso-ssh-e2e', 'hello.txt'))).toBe(false);

    const names = await ops.ls.readdir(cwd);
    expect(names).toEqual(expect.arrayContaining(['hello.txt', 'AGENTS.md', '.git']));

    const found = await ops.find.glob('*.txt', cwd, { ignore: ['.git'], limit: 50 });
    expect(found.some((p) => p.endsWith('hello.txt'))).toBe(true);

    const grep = createRemoteGrepToolDefinition(cwd, executor);
    const grepResult = await grep.execute(
      'g1',
      { pattern: 'remote-e2e-hello' },
      undefined,
      undefined,
      ctx
    );
    expect(JSON.stringify(grepResult.content)).toMatch(/hello\.txt/);

    let bashOut = '';
    const bash = await ops.bash.exec('pwd && hostname', cwd, {
      onData: (chunk) => {
        bashOut += chunk.toString();
      },
    });
    expect(bash.exitCode).toBe(0);
    expect(bashOut).toContain(cwd);

    await ops.write.writeFile(`${cwd}/from-enso.txt`, 'written-over-ssh\n');
    const afterWrite = await ops.read.readFile(`${cwd}/from-enso.txt`);
    expect(afterWrite.toString('utf8')).toBe('written-over-ssh\n');
    expect(existsSync('/root/enso-ssh-e2e/from-enso.txt')).toBe(false);

    const original = (await ops.read.readFile(`${cwd}/hello.txt`)).toString('utf8');
    await ops.edit.writeFile(`${cwd}/hello.txt`, original.replace('hello', 'HELLO'));
    const edited = (await ops.read.readFile(`${cwd}/hello.txt`)).toString('utf8');
    expect(edited).toContain('remote-e2e-HELLO');
    await ops.edit.writeFile(`${cwd}/hello.txt`, original);
  });

  it('远端 AGENTS.md 可 cat;不存在时静默空', async () => {
    const ok = await executor.exec(['cat', '--', `${cwd}/AGENTS.md`]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('Remote E2E Agents');
    const missing = await executor.exec(['cat', '--', `${cwd}/NO-SUCH-AGENTS.md`]);
    expect(missing.code).not.toBe(0);
  });

  it('checkpoint 打到远端 refs/enso-checkpoints,还原能恢复工作树', async () => {
    const hostImpl = createRemoteCheckpointHost(executor);
    await ops.write.writeFile(`${cwd}/cp-before.txt`, 'before-checkpoint\n');
    const cp = await createCheckpoint(
      {
        root: cwd,
        id: `e2e-${Date.now()}`,
        sessionId: 'e2e-live',
        trigger: 'tool',
        toolName: 'write',
      },
      hostImpl
    );
    const refs = await listCheckpointRefs(cwd, hostImpl);
    expect(refs).toContain(cp.id);

    await ops.write.writeFile(`${cwd}/cp-before.txt`, 'after-mutation\n');
    expect((await ops.read.readFile(`${cwd}/cp-before.txt`)).toString()).toBe('after-mutation\n');

    await restoreCheckpoint(cwd, cp, hostImpl);
    expect((await ops.read.readFile(`${cwd}/cp-before.txt`)).toString()).toBe(
      'before-checkpoint\n'
    );
  });
});
