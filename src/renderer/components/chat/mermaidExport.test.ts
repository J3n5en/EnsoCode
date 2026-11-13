import { describe, expect, it, vi } from 'vitest';
import {
  exportMermaidPng,
  MAX_CANVAS_SIDE,
  mermaidExportFileName,
  normalizeSvgMarkup,
  pngExportScale,
  svgViewBoxSize,
} from './mermaidExport';

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

describe('normalizeSvgMarkup', () => {
  it('根节点缺 xmlns 时补上，引用 xlink 时补 xmlns:xlink', () => {
    const out = normalizeSvgMarkup('<svg viewBox="0 0 10 20"><use xlink:href="#a"/></svg>');
    expect(out).toContain(SVG_NS);
    expect(out).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  });

  it('已有 xmlns 时不重复添加', () => {
    const out = normalizeSvgMarkup(`<svg ${SVG_NS} viewBox="0 0 10 20"></svg>`);
    expect(out.match(/\sxmlns="/g)).toHaveLength(1);
  });

  it('width/height 取自 viewBox，并去掉 max-width，导出尺寸不随预览缩放变化', () => {
    const out = normalizeSvgMarkup(
      `<svg ${SVG_NS} width="100%" viewBox="-8 -8 316.5 2400" style="max-width: 316.5px; background: red;"><g/></svg>`
    );
    expect(out).toContain('width="316.5"');
    expect(out).toContain('height="2400"');
    expect(out).not.toContain('100%');
    expect(out).not.toContain('max-width');
    expect(out).toContain('background: red');
    expect(out).toContain('<g/></svg>');
  });

  it('不是 svg 的输入原样返回', () => {
    expect(normalizeSvgMarkup('oops')).toBe('oops');
  });
});

describe('svgViewBoxSize', () => {
  it('解析 viewBox 宽高，非法时返回 null', () => {
    expect(svgViewBoxSize('<svg viewBox="0,0,120,3000">')).toEqual({ width: 120, height: 3000 });
    expect(svgViewBoxSize('<svg viewBox="0 0 0 10">')).toBeNull();
    expect(svgViewBoxSize('<svg width="10">')).toBeNull();
  });
});

describe('mermaidExportFileName', () => {
  it('生成只含安全字符的时间戳文件名', () => {
    const name = mermaidExportFileName('svg', new Date(2024, 0, 2, 3, 4, 5));
    expect(name).toBe('mermaid-20240102-030405.svg');
    expect(mermaidExportFileName('png')).toMatch(/^mermaid-\d{8}-\d{6}\.png$/);
  });
});

describe('pngExportScale', () => {
  it('默认 2x，长图收缩倍率不越过 canvas 单边上限', () => {
    expect(pngExportScale(400, 600)).toBe(2);
    const scale = pngExportScale(400, 12000);
    expect(scale).not.toBeNull();
    expect(12000 * (scale ?? 0)).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(scale).toBeGreaterThanOrEqual(1);
  });

  it('1x 都放不下时返回 null', () => {
    expect(pngExportScale(400, MAX_CANVAS_SIDE + 1)).toBeNull();
  });
});

describe('exportMermaidPng', () => {
  const current = `<svg ${SVG_NS} viewBox="0 0 100 50"><foreignObject/></svg>`;

  it('htmlLabels:false 重渲染失败时降级为导出当前 SVG', async () => {
    const render = vi.fn().mockRejectedValue(new Error('render failed'));
    const download = vi.fn();
    const rasterize = vi.fn();
    const result = await exportMermaidPng({
      currentSvg: () => current,
      rerender: render,
      rasterize,
      download,
    });
    expect(result).toEqual({ kind: 'svg', reason: 'rerender-failed' });
    expect(render).toHaveBeenCalledOnce();
    expect(rasterize).not.toHaveBeenCalled();
    const [blob, name] = download.mock.calls[0];
    expect(name).toMatch(/\.svg$/);
    expect((blob as Blob).type).toBe('image/svg+xml');
    expect(await (blob as Blob).text()).toContain('<foreignObject/>');
  });

  it('重渲染结果仍含 foreignObject 时也降级', async () => {
    const download = vi.fn();
    const result = await exportMermaidPng({
      currentSvg: () => current,
      rerender: async () => current,
      rasterize: vi.fn(),
      download,
    });
    expect(result).toEqual({ kind: 'svg', reason: 'rerender-failed' });
    expect(download).toHaveBeenCalledOnce();
  });

  it('超长图超出 canvas 上限时降级为 SVG', async () => {
    const rasterize = vi.fn();
    const download = vi.fn();
    const result = await exportMermaidPng({
      currentSvg: () => current,
      rerender: async () => `<svg ${SVG_NS} viewBox="0 0 300 20000"><text>a</text></svg>`,
      rasterize,
      download,
    });
    expect(result).toEqual({ kind: 'svg', reason: 'too-large' });
    expect(rasterize).not.toHaveBeenCalled();
    expect(download.mock.calls[0][1]).toMatch(/\.svg$/);
  });

  it('正常路径按 viewBox 尺寸与倍率栅格化并下载 PNG', async () => {
    const rasterize = vi.fn().mockResolvedValue('data:image/png;base64,AAAA');
    const download = vi.fn();
    const result = await exportMermaidPng({
      currentSvg: () => current,
      rerender: async () => `<svg viewBox="0 0 300 200"><text>a</text></svg>`,
      rasterize,
      download,
    });
    expect(result).toEqual({ kind: 'png' });
    const [markup, width, height, scale] = rasterize.mock.calls[0];
    expect(markup).toContain(SVG_NS);
    expect([width, height, scale]).toEqual([300, 200, 2]);
    expect(download).toHaveBeenCalledWith(
      'data:image/png;base64,AAAA',
      expect.stringMatching(/\.png$/)
    );
  });

  it('栅格化与降级都失败时返回 failed 而不抛出', async () => {
    const result = await exportMermaidPng({
      currentSvg: () => null,
      rerender: async () => `<svg viewBox="0 0 300 200"></svg>`,
      rasterize: vi.fn().mockRejectedValue(new Error('tainted')),
      download: vi.fn(),
    });
    expect(result).toEqual({ kind: 'failed' });
  });
});
