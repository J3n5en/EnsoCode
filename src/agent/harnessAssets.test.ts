import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHarnessRuleFiles, resolveHarnessSkillRoots } from './harnessAssets';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-harness-'));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe('resolveHarnessSkillRoots', () => {
  it('只返回项目内真实存在的 .claude/.codex/.cursor skills 目录', () => {
    fs.mkdirSync(path.join(cwd, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.cursor', 'skills'), { recursive: true });
    expect(resolveHarnessSkillRoots(cwd)).toEqual([
      path.join(cwd, '.claude', 'skills'),
      path.join(cwd, '.cursor', 'skills'),
    ]);
  });

  it('skills 是文件而非目录时跳过', () => {
    write('.codex/skills', 'not a dir');
    expect(resolveHarnessSkillRoots(cwd)).toEqual([]);
  });

  it('cwd 不存在时返回空数组', () => {
    expect(resolveHarnessSkillRoots(path.join(cwd, 'nope'))).toEqual([]);
  });
});

describe('readHarnessRuleFiles', () => {
  it('读取 .cursorrules、.cursor/rules/*.mdc|md 与 .claude/rules/*.md，按路径排序', () => {
    write('.cursorrules', 'root rules');
    write('.cursor/rules/b.mdc', 'rule b');
    write('.cursor/rules/a.md', 'rule a');
    write('.claude/rules/c.md', 'rule c');
    // 不认的扩展名与散文件不收
    write('.cursor/rules/notes.txt', 'ignored');
    write('.cursor/README.md', 'ignored');

    const files = readHarnessRuleFiles(cwd);
    expect(files.map((f) => path.relative(cwd, f.path).split(path.sep).join('/'))).toEqual([
      '.claude/rules/c.md',
      '.cursor/rules/a.md',
      '.cursor/rules/b.mdc',
      '.cursorrules',
    ]);
    expect(files.find((f) => f.path.endsWith('.cursorrules'))?.content).toBe('root rules');
  });

  it('递归收集 .cursor/rules 的子目录', () => {
    write('.cursor/rules/frontend/react.mdc', 'react');
    expect(readHarnessRuleFiles(cwd).map((f) => f.content)).toEqual(['react']);
  });

  it('.mdc frontmatter 去掉，但 globs 作用范围保留为一行说明', () => {
    write(
      '.cursor/rules/ts.mdc',
      '---\ndescription: TS 规则\nglobs: "src/**/*.ts"\nalwaysApply: false\n---\n\n# 正文\n用 strict'
    );
    const [file] = readHarnessRuleFiles(cwd);
    expect(file.content).not.toContain('alwaysApply');
    expect(file.content).toContain('src/**/*.ts');
    expect(file.content).toContain('# 正文\n用 strict');
  });

  it('坏 frontmatter 不抛错，原文照收', () => {
    write('.cursor/rules/bad.mdc', '---\nglobs: [unclosed\n---\nbody');
    const [file] = readHarnessRuleFiles(cwd);
    expect(file.content).toContain('body');
  });

  it('跳过空文件；目录不存在返回空数组', () => {
    write('.cursorrules', '   \n');
    expect(readHarnessRuleFiles(cwd)).toEqual([]);
    expect(readHarnessRuleFiles(path.join(cwd, 'nope'))).toEqual([]);
  });
});
