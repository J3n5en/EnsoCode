import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { suggestPaths, withPathHints } from './pathHints';

let cwd: string;
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'enso-path-hints-')));
  await mkdir(path.join(cwd, 'src/agent/tools'), { recursive: true });
  await mkdir(path.join(cwd, 'node_modules/pkg'), { recursive: true });
  await writeFile(path.join(cwd, 'src/agent/tools/read.ts'), '');
  await writeFile(path.join(cwd, 'src/agent/supervisor.ts'), '');
  await writeFile(path.join(cwd, 'node_modules/pkg/read.ts'), '');
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('suggestPaths', () => {
  it('按同名文件和拼错的目录给出现有路径，跳过 node_modules', async () => {
    expect(await suggestPaths('src/agnt/read.ts', cwd)).toEqual(['src/agent/tools/read.ts']);
    expect(await suggestPaths('src/agent/supervisr.ts', cwd)).toEqual(['src/agent/supervisor.ts']);
    expect(await suggestPaths(path.join(cwd, 'src/agent/tool'), cwd)).toEqual(['src/agent/tools']);
  });

  it('没有相近的路径时返回空', async () => {
    expect(await suggestPaths('zzz/qqq.md', cwd)).toEqual([]);
  });
});

describe('withPathHints', () => {
  const failing = (message: string) =>
    ({
      name: 'read',
      execute: async () => {
        throw new Error(message);
      },
    }) as unknown as ToolDefinition;

  it('路径不存在时在报错后附上相近路径', async () => {
    const tool = withPathHints(failing('ENOENT: no such file or directory, access'), cwd);
    await expect(
      tool.execute(
        't',
        { path: 'src/agent/supervisr.ts' },
        undefined,
        undefined,
        undefined as never
      )
    ).rejects.toThrow(/ENOENT[\s\S]*src\/agent\/supervisor\.ts/);
  });

  it('读目录时提示改用 ls，其它错误原样抛出', async () => {
    const dir = withPathHints(failing('EISDIR: illegal operation on a directory, read'), cwd);
    await expect(
      dir.execute('t', { path: 'src' }, undefined, undefined, undefined as never)
    ).rejects.toThrow(/directory[\s\S]*ls/);
    const other = withPathHints(failing('boom'), cwd);
    await expect(
      other.execute('t', { path: 'src/x' }, undefined, undefined, undefined as never)
    ).rejects.toThrow(/^boom$/);
  });
});
