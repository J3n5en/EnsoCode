import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { countBoxesInSource } from './kit/boxes';

const DIR = fileURLToPath(new URL('.', import.meta.url));

function pageSources(): { file: string; boxes: number }[] {
  const out: { file: string; boxes: number }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'kit') walk(path);
      } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
        out.push({
          file: relative(DIR, path),
          boxes: countBoxesInSource(readFileSync(path, 'utf8')),
        });
      }
    }
  };
  walk(DIR);
  return out;
}

/** 设置页内容渲染在主区那一层卡片里，页面代码再画任何带框容器就是卡片套卡片：没有例外，全部扫描 */
describe('设置页不套卡片', () => {
  it('没有任何页面画带框容器', () => {
    const pages = pageSources();
    expect(pages.length).toBeGreaterThan(30);
    expect(pages.filter((p) => p.boxes > 0)).toEqual([]);
  });
});
