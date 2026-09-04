import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * 项目内其它 harness（Claude Code / Codex / Cursor）的资源发现。
 * pi 只认 .agents/skills、.pi/skills 与 AGENTS.md/CLAUDE.md；这里把同目录下
 * 别家约定的 skills 根与规则文件补上，由「加载项目内其它工具目录」开关控制。
 */

/** 各家 harness 在项目内放 skills 的目录 */
const HARNESS_SKILL_ROOTS = [
  ['.claude', 'skills'],
  ['.codex', 'skills'],
  ['.cursor', 'skills'],
] as const;

/** 递归收集的规则目录（含允许的扩展名） */
const HARNESS_RULE_DIRS: ReadonlyArray<{ dir: readonly string[]; exts: readonly string[] }> = [
  { dir: ['.cursor', 'rules'], exts: ['.mdc', '.md'] },
  { dir: ['.claude', 'rules'], exts: ['.md'] },
];

/** 单文件规则 */
const HARNESS_RULE_FILES = ['.cursorrules'] as const;

export interface HarnessRuleFile {
  path: string;
  content: string;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 项目内存在的 harness skills 根目录（绝对路径，顺序固定） */
export function resolveHarnessSkillRoots(cwd: string): string[] {
  return HARNESS_SKILL_ROOTS.map((segments) => path.join(cwd, ...segments)).filter(isDir);
}

function collectFiles(dir: string, exts: readonly string[], out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, exts, out);
    } else if (entry.isFile() && exts.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

/**
 * .mdc 的 frontmatter 是 Cursor 的元数据（description/globs/alwaysApply），
 * 对模型没有指令意义；但 globs 说明规则的适用范围，保留成一行说明再接正文。
 */
export function stripMdcFrontmatter(raw: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return raw;
  const body = raw.slice(match[0].length);
  let meta: unknown;
  try {
    meta = parseYaml(match[1]);
  } catch {
    return raw;
  }
  if (!meta || typeof meta !== 'object') return body;
  const globs = (meta as Record<string, unknown>).globs;
  const scope = Array.isArray(globs)
    ? globs.filter((g): g is string => typeof g === 'string').join(', ')
    : typeof globs === 'string'
      ? globs
      : '';
  return scope ? `Applies to files matching: ${scope}\n\n${body.replace(/^\s+/, '')}` : body;
}

/** 读取项目内其它 harness 的规则文件；按路径排序，空文件跳过 */
export function readHarnessRuleFiles(cwd: string): HarnessRuleFile[] {
  const candidates: string[] = [];
  for (const { dir, exts } of HARNESS_RULE_DIRS) {
    collectFiles(path.join(cwd, ...dir), exts, candidates);
  }
  for (const name of HARNESS_RULE_FILES) {
    const file = path.join(cwd, name);
    try {
      if (fs.statSync(file).isFile()) candidates.push(file);
    } catch {
      // 不存在
    }
  }
  candidates.sort();

  const files: HarnessRuleFile[] = [];
  for (const file of candidates) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const content = file.endsWith('.mdc') ? stripMdcFrontmatter(raw) : raw;
    if (content.trim().length === 0) continue;
    files.push({ path: file, content });
  }
  return files;
}
