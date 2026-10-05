import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectedMessage } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  artifactCandidates,
  artifactKind,
  isOpenableArtifact,
  parseArtifactTarget,
  resolveArtifactFile,
  resolveArtifacts,
  textPathCandidates,
  turnBounds,
  turnOfReply,
} from './artifacts';

const text = (role: string, value: string): ProjectedMessage => ({
  role,
  content: [{ type: 'text', text: value }],
});
const call = (name: string, args: Record<string, unknown>): ProjectedMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id: `${name}-1`, name, arguments: args }],
});

describe('textPathCandidates', () => {
  it('提取绝对路径、相对路径与带扩展名的文件名', () => {
    expect(
      textPathCandidates(
        '写好了 `docs/report.md` 和 /tmp/x/index.html，另见 notes.txt。代码在 src/app.ts:12:3'
      )
    ).toEqual(['docs/report.md', '/tmp/x/index.html', 'notes.txt', 'src/app.ts']);
  });
  it('markdown 链接与 file:// 取路径，网址忽略', () => {
    expect(
      textPathCandidates(
        '[报告](./out/r.md) 见 https://example.com/a.html 和 file:///Users/me/w/a.png'
      )
    ).toEqual(['./out/r.md', '/Users/me/w/a.png']);
  });
  it('普通单词、版本号之外的无扩展名单词不算', () => {
    expect(textPathCandidates('hello world, done!')).toEqual([]);
  });
});

describe('artifactCandidates', () => {
  it('写文件类工具路径在前，正文路径在后，去重', () => {
    const messages: ProjectedMessage[] = [
      call('write', { path: 'a.md', content: 'x' }),
      call('edit', { path: '/w/b.ts' }),
      call('read', { path: 'ignored.md' }),
      {
        role: 'toolResult',
        toolName: 'apply_patch',
        content: [],
        fileChanges: [
          { path: 'c.html', oldText: '', newText: 'x', type: 'add' },
          { path: 'gone.md', oldText: 'x', newText: '', type: 'delete' },
        ],
      },
      text('assistant', '完成：a.md 与 d.png'),
    ];
    expect(artifactCandidates(messages)).toEqual(['a.md', '/w/b.ts', 'c.html', 'd.png']);
  });
});

describe('turnBounds / turnOfReply', () => {
  const messages = [
    text('user', 'q1'),
    text('assistant', 'a1'),
    text('user', 'q2'),
    call('write', { path: 'x.md' }),
    text('toolResult', 'ok'),
    text('assistant', 'done x.md'),
    text('user', 'q3'),
  ];
  it('按助手消息下标取所在轮（两条用户消息之间）', () => {
    expect(turnBounds(messages, 5)).toEqual({ start: 3, end: 6 });
    expect(turnBounds(messages, 1)).toEqual({ start: 1, end: 2 });
    expect(turnBounds(messages, 2)).toBeNull();
    expect(turnBounds(messages, 99)).toBeNull();
  });
  it('按最终回复文本定位最近一轮，找不到返回 null', () => {
    expect(turnOfReply(messages, ' done x.md ')).toEqual({ start: 3, end: 6 });
    expect(turnOfReply(messages, 'nope')).toBeNull();
  });
});

describe('artifactKind', () => {
  it('按扩展名分类', () => {
    expect(artifactKind('a.PNG')).toBe('image');
    expect(artifactKind('a.md')).toBe('markdown');
    expect(artifactKind('a.htm')).toBe('html');
    expect(artifactKind('a.pdf')).toBe('pdf');
    expect(artifactKind('a.ts')).toBe('text');
    expect(artifactKind('a.zip')).toBe('other');
    expect(artifactKind('Makefile')).toBe('other');
  });
});

describe('parseArtifactTarget', () => {
  const chatId = '11111111-1111-4111-8111-111111111111';
  it('群条目或私聊会话 + 消息下标', () => {
    expect(parseArtifactTarget({ chatId, entryId: 'e1', extra: 1 })).toEqual({
      chatId,
      entryId: 'e1',
    });
    expect(parseArtifactTarget({ chatId, conversationId: 'c', messageIndex: 3 })).toEqual({
      chatId,
      conversationId: 'c',
      messageIndex: 3,
    });
  });
  it('拒绝坏入参与路径类字段', () => {
    for (const bad of [
      null,
      [],
      { chatId: 'x', entryId: 'e1' },
      { chatId },
      { chatId, entryId: '' },
      { chatId, entryId: 'e'.repeat(201) },
      { chatId, conversationId: 'c' },
      { chatId, conversationId: 'c', messageIndex: -1 },
      { chatId, conversationId: 'c', messageIndex: 1.5 },
      { chatId, conversationId: '', messageIndex: 1 },
    ]) {
      expect(parseArtifactTarget(bad)).toBeNull();
    }
  });
});

describe('isOpenableArtifact', () => {
  it('可执行与脚本类文件不交给默认应用', () => {
    expect(isOpenableArtifact('a.md', 0o644)).toBe(true);
    expect(isOpenableArtifact('a.png', 0o644)).toBe(true);
    expect(isOpenableArtifact('run.sh', 0o644)).toBe(false);
    expect(isOpenableArtifact('x.command', 0o644)).toBe(false);
    expect(isOpenableArtifact('tool.py', 0o644)).toBe(false);
    expect(isOpenableArtifact('a.txt', 0o755)).toBe(false);
  });
});

describe('resolveArtifacts', () => {
  let base = '';
  let root = '';
  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'bot-artifacts-')));
    root = path.join(base, 'ws');
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'r.md'), '# hi');
    writeFileSync(path.join(root, 'page.html'), '<p>x</p>');
    writeFileSync(path.join(base, 'secret.txt'), 'secret');
    symlinkSync(path.join(base, 'secret.txt'), path.join(root, 'escape.txt'));
    symlinkSync(path.join(root, 'page.html'), path.join(root, 'alias.html'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('只保留存在且位于工作区根内的普通文件', () => {
    const result = resolveArtifacts(root, [
      'docs/r.md',
      path.join(root, 'page.html'),
      '../secret.txt',
      path.join(base, 'secret.txt'),
      'escape.txt',
      'missing.md',
      'docs',
      './docs/../docs/r.md',
    ]);
    expect(result).toEqual([
      { rel: 'docs/r.md', name: 'r.md', size: 4, kind: 'markdown' },
      { rel: 'page.html', name: 'page.html', size: 8, kind: 'html' },
    ]);
  });

  it('工作区内的符号链接按真实目标去重', () => {
    expect(resolveArtifacts(root, ['alias.html', 'page.html']).map((a) => a.rel)).toEqual([
      'page.html',
    ]);
  });

  it('每条最多 8 张', () => {
    const names = Array.from({ length: 12 }, (_, i) => `f${i}.txt`);
    for (const name of names) writeFileSync(path.join(root, name), name);
    expect(resolveArtifacts(root, names)).toHaveLength(8);
  });

  it('工作区根不存在时为空', () => {
    expect(resolveArtifacts(path.join(base, 'nope'), ['a.md'])).toEqual([]);
  });

  it('resolveArtifactFile 只接受根内的相对路径', () => {
    expect(resolveArtifactFile(root, 'docs/r.md')).toBe(path.join(root, 'docs', 'r.md'));
    expect(resolveArtifactFile(root, '../secret.txt')).toBeNull();
    expect(resolveArtifactFile(root, path.join(base, 'secret.txt'))).toBeNull();
    expect(resolveArtifactFile(root, 'escape.txt')).toBeNull();
    expect(resolveArtifactFile(root, 'docs')).toBeNull();
  });
});
