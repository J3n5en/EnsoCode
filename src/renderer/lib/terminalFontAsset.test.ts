import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readTerminalFont() {
  const cssUrl = new URL('../styles/terminal-fonts.css', import.meta.url);
  const css = readFileSync(cssUrl, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const face = css.match(
    /@font-face\s*\{[^}]*font-family:\s*["']Enso Nerd Symbols["'][^}]*\}/
  )?.[0];
  const source = face?.match(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/);
  const relativeUrl = source?.[1] ?? source?.[2] ?? source?.[3];
  if (!relativeUrl) throw new Error('Missing Enso Nerd Symbols font URL in terminal-fonts.css');
  return readFileSync(new URL(relativeUrl, cssUrl));
}

function parseFont(font: Buffer) {
  expect(font.readUInt32BE(0), 'TrueType sfnt version').toBe(0x00010000);
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const record = 12 + i * 16;
    const tag = font.toString('ascii', record, record + 4);
    const offset = font.readUInt32BE(record + 8);
    const length = font.readUInt32BE(record + 12);
    expect(offset + length, `${tag} table bounds`).toBeLessThanOrEqual(font.length);
    tables.set(tag, font.subarray(offset, offset + length));
  }
  function table(tag: string) {
    const value = tables.get(tag);
    if (!value) throw new Error(`Missing sfnt table: ${tag}`);
    return value;
  }

  const head = table('head');
  const unitsPerEm = head.readUInt16BE(18);
  const locaFormat = head.readInt16BE(50);
  const metricCount = table('hhea').readUInt16BE(34);
  const glyphCount = table('maxp').readUInt16BE(4);
  const hmtx = table('hmtx');
  const loca = table('loca');
  const glyf = table('glyf');
  const cmap = table('cmap');
  expect(unitsPerEm, 'unitsPerEm').toBeGreaterThan(0);
  expect([0, 1], 'indexToLocFormat').toContain(locaFormat);
  expect(metricCount, 'numberOfHMetrics').toBeGreaterThan(0);
  expect(metricCount).toBeLessThanOrEqual(glyphCount);

  const mappings: Array<{ format: number; data: Buffer }> = [];
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const record = 4 + i * 8;
    const platform = cmap.readUInt16BE(record);
    const encoding = cmap.readUInt16BE(record + 2);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) {
      continue;
    }
    const offset = cmap.readUInt32BE(record + 4);
    const format = cmap.readUInt16BE(offset);
    if (format !== 4 && format !== 12) continue;
    const length = format === 4 ? cmap.readUInt16BE(offset + 2) : cmap.readUInt32BE(offset + 4);
    expect(offset + length, `cmap format ${format} bounds`).toBeLessThanOrEqual(cmap.length);
    mappings.push({ format, data: cmap.subarray(offset, offset + length) });
  }
  expect(mappings.length, 'Unicode cmap format 4 or 12').toBeGreaterThan(0);

  function glyphId(codePoint: number) {
    // BMP 优先读取 format 4；补充平面读取 format 12，缺失时尝试其余 Unicode 子表。
    //
    // Prefer format 4 for BMP and format 12 for supplementary code points, then try other Unicode subtables.
    const preferredFormat = codePoint <= 0xffff ? 4 : 12;
    const ordered = [...mappings].sort(
      (a, b) => Number(b.format === preferredFormat) - Number(a.format === preferredFormat)
    );
    for (const { format, data } of ordered) {
      if (format === 12) {
        for (let i = 0; i < data.readUInt32BE(12); i++) {
          const group = 16 + i * 12;
          const start = data.readUInt32BE(group);
          const end = data.readUInt32BE(group + 4);
          if (codePoint < start || codePoint > end) continue;
          const id = data.readUInt32BE(group + 8) + codePoint - start;
          if (id !== 0) return id;
        }
      } else if (codePoint <= 0xffff) {
        const segments = data.readUInt16BE(6) / 2;
        const starts = 16 + segments * 2;
        const deltas = starts + segments * 2;
        const ranges = deltas + segments * 2;
        for (let i = 0; i < segments; i++) {
          const start = data.readUInt16BE(starts + i * 2);
          const end = data.readUInt16BE(14 + i * 2);
          if (codePoint < start || codePoint > end) continue;
          const delta = data.readInt16BE(deltas + i * 2);
          const rangeAddress = ranges + i * 2;
          const range = data.readUInt16BE(rangeAddress);
          const raw =
            range === 0
              ? codePoint
              : data.readUInt16BE(rangeAddress + range + (codePoint - start) * 2);
          const id = range !== 0 && raw === 0 ? 0 : (raw + delta) & 0xffff;
          if (id !== 0) return id;
        }
      }
    }
    return 0;
  }

  function metrics(id: number) {
    expect(id, 'glyph index within maxp.numGlyphs').toBeLessThan(glyphCount);
    const advance = hmtx.readUInt16BE(Math.min(id, metricCount - 1) * 4);
    const glyphOffset = (index: number) =>
      locaFormat === 0 ? loca.readUInt16BE(index * 2) * 2 : loca.readUInt32BE(index * 4);
    const start = glyphOffset(id);
    const end = glyphOffset(id + 1);
    expect(end - start, 'glyph has a glyf header and visible outline').toBeGreaterThanOrEqual(10);
    expect(end, 'glyf bounds').toBeLessThanOrEqual(glyf.length);
    return { advance, xMin: glyf.readInt16BE(start + 2), xMax: glyf.readInt16BE(start + 6) };
  }
  return { unitsPerEm, glyphId, metrics };
}

describe('终端 CSS 实际引用的符号字体资产', () => {
  const codePoints = [0xea83, 0xf408, 0xe0a0, 0xf044, 0xf00c, 0xe718, 0xe0b0, 0xe0b4, 0xf0001];

  // 真实复现：1em 图标放进约 0.55em 的 Consolas 单格后，右侧轮廓被下一格背景覆盖。
  //
  // Regression: a 1em icon in a roughly 0.55em Consolas cell is clipped by the next cell's background.
  it.each(
    codePoints.map((codePoint) => ({
      codePoint,
      label: `U+${codePoint.toString(16).toUpperCase()}`,
    }))
  )('$label 存在且字宽与轮廓均容纳于终端单列', ({ codePoint, label }) => {
    const font = parseFont(readTerminalFont());
    const id = font.glyphId(codePoint);
    expect(id, `${label} must map to a non-.notdef glyph`).toBeGreaterThan(0);
    const { advance, xMin, xMax } = font.metrics(id);
    const detail = `${label}: unitsPerEm=${font.unitsPerEm}, advance=${advance}, bbox=[${xMin}, ${xMax}]`;
    // 左右允许 2% em 越界，供 Powerline 分隔符覆盖相邻单格间的细缝。
    //
    // Allow 2% em overscan on either side so Powerline separators can cover seams between cells.
    const overscan = font.unitsPerEm * 0.02;
    expect.soft(advance, detail).toBeGreaterThan(0);
    expect.soft(advance, detail).toBeLessThanOrEqual(font.unitsPerEm * 0.55);
    expect.soft(xMin, detail).toBeGreaterThanOrEqual(-overscan);
    expect.soft(xMax, detail).toBeGreaterThan(xMin);
    expect.soft(xMax, detail).toBeLessThanOrEqual(advance + overscan);
  });
});
