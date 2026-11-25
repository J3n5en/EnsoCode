import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const COMPONENTS = resolve(DIR, '..');
const isSource = (name: string) => /\.tsx?$/.test(name) && !name.includes('.test.');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return isSource(e.name) ? [path] : [];
  });
}

/** 设置页渲染的文案也来自别处的组件（秘书联系方式面板、档案表单等）：沿 import 把它们一并收进来，ui 原语除外 */
function withImports(files: string[]): string[] {
  const seen = new Set(files);
  const queue = [...files];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    for (const m of readFileSync(file, 'utf8').matchAll(
      /from '(@\/components\/[^']+|\.{1,2}\/[^']+)'/g
    )) {
      const spec = m[1];
      const base = spec.startsWith('@/components/')
        ? join(COMPONENTS, spec.slice('@/components/'.length))
        : resolve(dirname(file), spec);
      if (!base.startsWith(COMPONENTS) || base.startsWith(join(COMPONENTS, 'ui'))) continue;
      const hit = ['.tsx', '.ts', '/index.ts'].map((ext) => base + ext).find(existsSync);
      if (hit && isSource(hit) && !seen.has(hit)) {
        seen.add(hit);
        queue.push(hit);
      }
    }
  }
  return [...seen];
}

/** t( 的第一个参数里出现的所有字符串：字面量、无插值模板、三元两支、?? 兜底 */
function keysIn(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(/(?<![\w.$])t\(/g)) {
    let i = (m.index ?? 0) + 2;
    let depth = 0;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        let j = i + 1;
        let value = '';
        while (j < text.length && text[j] !== ch) {
          if (text[j] === '\\') {
            value += text[j + 1];
            j += 2;
            continue;
          }
          value += text[j];
          j++;
        }
        if (!(ch === '`' && value.includes('${'))) keys.push(value);
        i = j;
      } else if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) break;
      else if (ch === '=' && text[i + 1] === '=' && depth === 0) break;
    }
  }
  return keys;
}

describe('设置页文案', () => {
  it('设置页及其引入的组件里，传给 t() 的每段文案都有中文翻译', () => {
    const missing: string[] = [];
    for (const file of withImports(sources(DIR))) {
      const text = readFileSync(file, 'utf8');
      for (const key of keysIn(text)) {
        if (key && !(key in zhTranslations)) missing.push(`${relative(COMPONENTS, file)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('扫描范围覆盖设置页引入的外部组件，且能取到三元、?? 兜底与无插值模板里的文案', () => {
    const files = withImports(sources(DIR)).map((f) => relative(COMPONENTS, f));
    expect(files).toEqual(
      expect.arrayContaining([
        'secretary/SecretaryContactPanel.tsx',
        'secretary/SecretaryProfileForm.tsx',
        'settings/SecretarySettings.tsx',
      ])
    );
    expect(files.some((f) => f.startsWith('ui/'))).toBe(false);
    expect(
      keysIn(
        "t(a ? 'Yes one' : 'No one', { n }); t(MAP[k] ?? 'Fallback'); t(`Plain`); t(`x$" + '{y}`)'
      )
    ).toEqual(['Yes one', 'No one', 'Fallback', 'Plain']);
  });
});
