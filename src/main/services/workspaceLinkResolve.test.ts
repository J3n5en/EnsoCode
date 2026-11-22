import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_LINK_BATCH, resolveWorkspaceLinks } from './workspaceLinkResolve';

let root = '';
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'link-resolve-')));
  mkdirSync(path.join(root, 'src/sub'), { recursive: true });
  writeFileSync(path.join(root, 'src/a.ts'), '');
  writeFileSync(path.join(root, 'top.ts'), '');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveWorkspaceLinks', () => {
  it('存在的文件/目录返回类型，不存在、越界、绝对路径返回 null', async () => {
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'link-out-')));
    writeFileSync(path.join(outside, 'x.ts'), '');
    symlinkSync(outside, path.join(root, 'escape'));
    try {
      expect(
        await resolveWorkspaceLinks(root, [
          'src/a.ts',
          'src/sub',
          'top.ts',
          'oauthProviders.ts',
          'src/missing.ts',
          '../x.ts',
          '/etc/hosts',
          'escape/x.ts',
          'src\\a.ts',
        ])
      ).toEqual([
        { rel: 'src/a.ts', kind: 'file' },
        { rel: 'src/sub', kind: 'dir' },
        { rel: 'top.ts', kind: 'file' },
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('非字符串与超量条目不处理，结果与输入等长', async () => {
    const rels = Array.from({ length: MAX_LINK_BATCH + 5 }, () => 'src/a.ts');
    const result = await resolveWorkspaceLinks(root, [42, ...rels] as unknown[]);
    expect(result).toHaveLength(MAX_LINK_BATCH);
    expect(result[0]).toBeNull();
    expect(result[1]).toEqual({ rel: 'src/a.ts', kind: 'file' });
  });

  it('超时未完成的条目按打不开处理', async () => {
    const result = await resolveWorkspaceLinks(root, ['src/a.ts'], { timeoutMs: 0 });
    expect(result).toEqual([null]);
  });

  it('工作区根不存在时全部打不开', async () => {
    expect(await resolveWorkspaceLinks(path.join(root, 'nope'), ['src/a.ts'])).toEqual([null]);
  });
});
