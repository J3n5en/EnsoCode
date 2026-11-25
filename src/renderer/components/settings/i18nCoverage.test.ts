import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('.', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith('.tsx') && !e.name.includes('.test.') ? [path] : [];
  });
}

describe('设置页文案', () => {
  it("每个 t('字面量') 都有中文翻译", () => {
    const missing: string[] = [];
    for (const file of sources(DIR)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
        const key = m[2].replace(/\\(['"\\])/g, '$1');
        if (!(key in zhTranslations)) missing.push(`${relative(DIR, file)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
