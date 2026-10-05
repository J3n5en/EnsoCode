import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  isWorkspaceWideCommand,
  WorkspaceClaims,
  withExclusiveCommand,
  withFileClaims,
} from './workspaceClaims';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claims-')));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(timeoutMs = 1000) {
  const claims = new WorkspaceClaims({ timeoutMs });
  claims.register({ id: 'a', label: 'alice', ancestors: [] });
  claims.register({ id: 'b', label: 'bob', ancestors: [] });
  claims.register({ id: 'child', label: 'carol', ancestors: ['a'] });
  return claims;
}

describe('WorkspaceClaims 文件级写占用', () => {
  it('不同文件并行；同一文件被别人占用时等到对方释放', async () => {
    const claims = setup();
    await claims.claimFiles('a', root, ['src/x.ts']);
    await claims.claimFiles('b', root, ['src/y.ts']);
    let done = false;
    const waiting = claims.claimFiles('b', root, ['./src/x.ts']).then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    await claims.claimFiles('a', root, ['src/x.ts']);
    claims.release('a');
    await waiting;
    expect(done).toBe(true);
  });

  it('委派链上的祖先与子会话不互相阻塞', async () => {
    const claims = setup();
    await claims.claimFiles('a', root, ['f.ts']);
    await claims.claimFiles('child', root, ['f.ts']);
    await claims.runExclusive('child', root, async () => 'ok');
  });

  it('等待超时给出占用者与文件，并只提示一次正在等待', async () => {
    const claims = setup(30);
    const onWait = vi.fn();
    await claims.claimFiles('a', root, ['src/x.ts']);
    await expect(claims.claimFiles('b', root, ['src/x.ts'], { onWait })).rejects.toThrow(
      /src\/x\.ts.*alice/
    );
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onWait.mock.calls[0][0]).toMatch(/alice/);
  });

  it('中止信号立即结束等待', async () => {
    const claims = setup();
    await claims.claimFiles('a', root, ['x']);
    const controller = new AbortController();
    const waiting = claims.claimFiles('b', root, ['x'], { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toThrow();
  });

  it('不同工作区互不影响', async () => {
    const claims = setup();
    const other = realpathSync(mkdtempSync(path.join(tmpdir(), 'claims-')));
    await claims.claimFiles('a', root, ['x']);
    await claims.claimFiles('b', other, ['x']);
    await claims.runExclusive('b', other, async () => undefined);
  });
});

describe('WorkspaceClaims 全局命令短独占', () => {
  it('别人占着文件时全局命令等其释放；命令执行期间别人改文件要等命令结束', async () => {
    const claims = setup();
    await claims.claimFiles('a', root, ['x']);
    const order: string[] = [];
    const exclusive = claims.runExclusive('b', root, async () => {
      order.push('git');
      await flush();
      order.push('git-done');
    });
    await flush();
    expect(order).toEqual([]);
    claims.release('a');
    await flush();
    const edit = claims.claimFiles('a', root, ['y']).then(() => order.push('edit'));
    await Promise.all([exclusive, edit]);
    expect(order).toEqual(['git', 'git-done', 'edit']);
    // 命令结束即释放，不持有到轮末
    await claims.claimFiles('a', root, ['z']);
  });
});

describe('isWorkspaceWideCommand', () => {
  it.each([
    'git commit -m x',
    'git -C sub checkout main',
    'cd a && git stash',
    'git reset --soft HEAD~1',
    'pnpm install',
    'npm i lodash',
    'yarn',
    'bun add zod',
    'rm -rf dist',
    'bash -c "git pull"',
  ])('全局：%s', (command) => expect(isWorkspaceWideCommand(command)).toBe(true));

  it.each([
    'git status',
    'git diff HEAD',
    'git log -5',
    'pnpm test',
    'npm run build',
    'rm a.txt',
    'ls -la',
    'echo "git commit"',
  ])('非全局：%s', (command) => expect(isWorkspaceWideCommand(command)).toBe(false));
});

describe('工具包装', () => {
  const def = (name: string, execute = vi.fn(async () => ({ content: [] }))) =>
    ({ name, execute }) as never as Parameters<typeof withFileClaims>[0];

  it('写工具执行前按目标文件占用；被占时等待并推送等待提示', async () => {
    const claims = setup();
    await claims.claimFiles('a', root, ['x.ts']);
    const inner = vi.fn(async () => ({ content: [] }));
    const wrapped = withFileClaims(def('edit', inner), claims, { owner: 'b', cwd: root });
    const onUpdate = vi.fn();
    const run = wrapped.execute('t', { path: 'x.ts' }, undefined, onUpdate, undefined as never);
    await flush();
    expect(inner).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    claims.release('a');
    await run;
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('只有全局命令走独占；普通命令直接执行', async () => {
    const claims = setup();
    await claims.claimFiles('a', root, ['x.ts']);
    const inner = vi.fn(async () => ({ content: [] }));
    const wrapped = withExclusiveCommand(def('bash', inner), claims, { owner: 'b', cwd: root });
    await wrapped.execute('t', { command: 'pnpm test' }, undefined, undefined, undefined as never);
    expect(inner).toHaveBeenCalledTimes(1);
    const run = wrapped.execute(
      't',
      { command: 'git commit -am x' },
      undefined,
      undefined,
      undefined as never
    );
    await flush();
    expect(inner).toHaveBeenCalledTimes(1);
    claims.release('a');
    await run;
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
