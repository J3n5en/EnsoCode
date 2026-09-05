import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import * as policy from './browserFileRoot';

const tmp = mkdtempSync(join(tmpdir(), 'browser-root-'));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
describe('workspace file security', () => {
  it('真实文件可打开，但符号链接逃逸、目录、缺失文件与无上下文拒绝', () => {
    const root = join(tmp, 'root');
    mkdirSync(root, { recursive: true });
    const inside = join(root, 'index.html');
    const outside = join(tmp, 'secret');
    writeFileSync(inside, 'ok');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(root, 'escape'));
    expect(policy).toHaveProperty('assertBrowserUrl');
    const check = (policy as unknown as { assertBrowserUrl: (raw: string, root?: string) => URL })
      .assertBrowserUrl;
    expect(check(pathToFileURL(inside).href, root).protocol).toBe('file:');
    for (const file of [outside, join(root, 'escape'), root, join(root, 'missing')]) {
      expect(() => check(pathToFileURL(file).href, root)).toThrow();
    }
    expect(() => check(pathToFileURL(inside).href)).toThrow();
  });
});
