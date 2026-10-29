import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectedMessage } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveExternalRevealTarget, sessionWrittenFiles } from './externalFileReveal';

let base = '';
let cwd = '';
let outside = '';
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'external-reveal-')));
  cwd = path.join(base, 'workspace');
  outside = path.join(base, 'temp');
  mkdirSync(cwd);
  mkdirSync(outside);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('resolveExternalRevealTarget', () => {
  it('工作区外存在的普通文件返回真实路径', () => {
    const file = path.join(outside, 'report.md');
    writeFileSync(file, 'x');
    expect(resolveExternalRevealTarget(file)).toEqual({ ok: true, real: file });
  });

  it('不存在、目录、相对路径、非字符串与 NUL 一律 invalid-path', () => {
    for (const input of [
      path.join(outside, 'missing.md'),
      outside,
      'temp/report.md',
      '../temp/report.md',
      42,
      undefined,
      `${outside}/a\0b`,
      `/${'a'.repeat(5000)}`,
    ]) {
      expect(resolveExternalRevealTarget(input)).toEqual({ ok: false, error: 'invalid-path' });
    }
  });

  it.skipIf(process.platform === 'win32')('软链接按真实目标判断', () => {
    const file = path.join(outside, 'real.md');
    writeFileSync(file, 'x');
    symlinkSync(file, path.join(outside, 'link.md'));
    symlinkSync(cwd, path.join(outside, 'dir-link'));
    expect(resolveExternalRevealTarget(path.join(outside, 'link.md'))).toEqual({
      ok: true,
      real: file,
    });
    expect(resolveExternalRevealTarget(path.join(outside, 'dir-link'))).toEqual({
      ok: false,
      error: 'invalid-path',
    });
  });
});

describe('sessionWrittenFiles', () => {
  const call = (id: string, name: string, args: unknown): ProjectedMessage => ({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
  });
  const result = (
    id: string,
    name: string,
    extra: Partial<ProjectedMessage> = {}
  ): ProjectedMessage => ({
    role: 'toolResult',
    toolName: name,
    toolCallId: id,
    content: [],
    ...extra,
  });

  it('只认成功的 write / edit / apply_patch 实际写过的文件，按真实路径比较', () => {
    const files = ['written.md', 'edited.md', 'patched.md', 'relative.md', 'failed.md'].map(
      (name) => path.join(outside, name)
    );
    for (const file of files) writeFileSync(file, 'x');
    writeFileSync(path.join(cwd, 'inside.md'), 'x');
    const messages: ProjectedMessage[] = [
      call('1', 'write', { path: files[0] }),
      result('1', 'write'),
      call('2', 'edit', { path: files[1] }),
      result('2', 'edit'),
      result('3', 'apply_patch', {
        fileChanges: [
          { path: files[2], oldText: '', newText: 'x', type: 'add' },
          { path: path.join(outside, 'gone.md'), oldText: 'x', newText: '', type: 'delete' },
        ],
      }),
      call('4', 'write', { path: '../temp/relative.md' }),
      result('4', 'write'),
      call('5', 'write', { path: files[4] }),
      result('5', 'write', { isError: true }),
      call('6', 'bash', { command: `echo > ${path.join(outside, 'bash.md')}` }),
      result('6', 'bash'),
      call('7', 'write', { path: path.join(outside, 'no-result.md') }),
    ];
    const written = sessionWrittenFiles(messages, cwd);
    expect(written.has(files[0])).toBe(true);
    expect(written.has(files[1])).toBe(true);
    expect(written.has(files[2])).toBe(true);
    expect(written.has(files[3])).toBe(true);
    expect(written.has(files[4])).toBe(false);
    expect(written.has(path.join(outside, 'bash.md'))).toBe(false);
    expect(written.has(path.join(outside, 'no-result.md'))).toBe(false);
    expect(written.has(path.join(outside, 'gone.md'))).toBe(false);
  });
});
