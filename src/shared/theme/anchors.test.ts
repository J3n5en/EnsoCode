import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_ANCHORS } from './anchors';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
  });
}

describe('THEME_ANCHORS', () => {
  const renderer = sources(join(__dirname, '../../renderer'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

  it.each(THEME_ANCHORS)('锚点 %s 至少挂在一个组件上', (anchor) => {
    expect(renderer).toMatch(new RegExp(`data-enso=(?:"${anchor}"|\\{'${anchor}'\\})`));
  });

  it('docs/theming.md 的锚点表与清单一致、顺序相同', () => {
    const doc = readFileSync(join(__dirname, '../../../docs/theming.md'), 'utf8');
    const section = doc.split(/^## 锚点\r?$/m)[1]?.split(/^## /m)[0] ?? '';
    const documented = [...section.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]);
    expect(documented).toEqual([...THEME_ANCHORS]);
  });
});
