import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readInstructionFiles } from './instructions';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-instructions-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('readInstructionFiles', () => {
  it('识别各家的指令文件名', () => {
    for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'SOUL.md']) {
      fs.writeFileSync(path.join(tmp, name), `内容 ${name}`);
    }
    const found = readInstructionFiles(tmp);
    expect(found.map((f) => f.name).sort()).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
      'SOUL.md',
    ]);
  });

  it('忽略其它 markdown 文件', () => {
    fs.writeFileSync(path.join(tmp, 'README.md'), 'x');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), 'x');
    expect(readInstructionFiles(tmp).map((f) => f.name)).toEqual(['CLAUDE.md']);
  });

  it('内容相同的两个文件哈希相同——即使文件名不同', () => {
    // 真实场景：~/.claude/CLAUDE.md 与 ~/.codex/AGENTS.md 是同一份内容
    const shared = '# 基础约束\n- 交互语言：中文\n';
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-b-'));
    try {
      fs.writeFileSync(path.join(a, 'CLAUDE.md'), shared);
      fs.writeFileSync(path.join(b, 'AGENTS.md'), shared);
      expect(readInstructionFiles(a)[0].hash).toBe(readInstructionFiles(b)[0].hash);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('文件名相同但内容不同则哈希不同', () => {
    // 真实场景：Grok / Factory / opencode 的 AGENTS.md 内容各异
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-b-'));
    try {
      fs.writeFileSync(path.join(a, 'AGENTS.md'), '内容甲');
      fs.writeFileSync(path.join(b, 'AGENTS.md'), '内容乙');
      expect(readInstructionFiles(a)[0].hash).not.toBe(readInstructionFiles(b)[0].hash);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('bytes 按 UTF-8 字节数而不是字符数计算', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '中文');
    expect(readInstructionFiles(tmp)[0].bytes).toBe(6);
  });

  it('location 经 display 函数转换', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), 'x');
    const [file] = readInstructionFiles(tmp, () => '~/.claude/CLAUDE.md');
    expect(file.location).toBe('~/.claude/CLAUDE.md');
    expect(file.path).toBe(path.join(tmp, 'CLAUDE.md'));
  });

  it('目录不存在时返回空数组', () => {
    expect(readInstructionFiles(path.join(tmp, 'nope'))).toEqual([]);
  });
});
