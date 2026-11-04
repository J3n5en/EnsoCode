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
});
