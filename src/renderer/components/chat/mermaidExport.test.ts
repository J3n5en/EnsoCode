// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  absolutizeEmTextPositions,
  exportMermaidPng,
  exportMermaidSvg,
  inlinePresentationAttrs,
  MAX_CANVAS_SIDE,
  materializeMarkers,
  mermaidExportFileName,
  normalizeSvgMarkup,
  pngExportScale,
  removeSvgStyleElements,
  resolveContextPaints,
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

describe('exportMermaidSvg', () => {
  const live = `<svg ${SVG_NS} viewBox="0 0 100 50"><foreignObject>live</foreignObject></svg>`;
  const clean = `<svg ${SVG_NS} viewBox="0 0 100 50"><text>rerendered</text></svg>`;

  it('重渲染产物无 foreignObject 时下载重渲染内容', async () => {
    const download = vi.fn();
    const result = await exportMermaidSvg({
      currentSvg: () => live,
      rerender: async () => clean,
      download,
    });
    expect(result).toEqual({ kind: 'svg', source: 'rerender' });
    expect(download).toHaveBeenCalledOnce();
    const [blob, name] = download.mock.calls[0];
    expect(name).toMatch(/\.svg$/);
    const text = await (blob as Blob).text();
    expect(text).toContain('<text>rerendered</text>');
    expect(text).not.toMatch(/<foreignObject\b/i);
  });

  it('重渲染产物含 foreignObject 时下载 live 内容', async () => {
    const download = vi.fn();
    const result = await exportMermaidSvg({
      currentSvg: () => live,
      rerender: async () =>
        `<svg ${SVG_NS} viewBox="0 0 10 10"><foreignObject>bad</foreignObject></svg>`,
      download,
    });
    expect(result).toEqual({ kind: 'svg', source: 'live' });
    const text = await (download.mock.calls[0][0] as Blob).text();
    expect(text).toContain('<foreignObject>live</foreignObject>');
    expect(text).not.toContain('bad');
  });

  it('重渲染抛错时回退 live', async () => {
    const download = vi.fn();
    const result = await exportMermaidSvg({
      currentSvg: () => live,
      rerender: async () => {
        throw new Error('render failed');
      },
      download,
    });
    expect(result).toEqual({ kind: 'svg', source: 'live' });
    expect(await (download.mock.calls[0][0] as Blob).text()).toContain(
      '<foreignObject>live</foreignObject>'
    );
  });

  it('重渲染抛错且 live 为空时返回 failed 且不下载', async () => {
    const download = vi.fn();
    const result = await exportMermaidSvg({
      currentSvg: () => null,
      rerender: async () => {
        throw new Error('render failed');
      },
      download,
    });
    expect(result).toEqual({ kind: 'failed' });
    expect(download).not.toHaveBeenCalled();
  });
});

const SVG_XMLNS = 'http://www.w3.org/2000/svg';

function parseSvg(markup: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.localName !== 'svg') throw new Error(`not svg: ${svg.textContent ?? ''}`);
  return svg as unknown as SVGSVGElement;
}

describe('inlinePresentationAttrs', () => {
  it('把计算样式写成呈现属性，而不是 style', () => {
    const svg = parseSvg(
      `<svg xmlns="${SVG_XMLNS}"><defs><marker id="m"><path id="p"/></marker></defs><rect id="n"/></svg>`
    );
    inlinePresentationAttrs(svg, (el) => {
      if (el.id === 'n' || el.id === 'p') {
        return { fill: 'rgb(236, 236, 255)', stroke: '#9370DB', 'font-size': '16px' };
      }
      return {};
    });
    const rect = svg.querySelector('#n');
    const head = svg.querySelector('#p');
    expect(rect?.getAttribute('fill')).toBe('rgb(236, 236, 255)');
    expect(rect?.getAttribute('stroke')).toBe('#9370DB');
    expect(rect?.getAttribute('font-size')).toBe('16px');
    expect(rect?.getAttribute('style')).toBeNull();
    expect(head?.getAttribute('fill')).toBe('rgb(236, 236, 255)');
    expect(new XMLSerializer().serializeToString(svg)).not.toContain('style=');
  });

  it('跳过等于初始值的 fill 与 stroke，非默认值仍写入', () => {
    const svg = parseSvg(`<svg xmlns="${SVG_XMLNS}"><rect id="n"/></svg>`);
    inlinePresentationAttrs(svg, () => ({
      fill: 'rgb(0, 0, 0)',
      stroke: 'none',
      'stroke-width': '2px',
    }));
    const rect = svg.querySelector('#n');
    expect(rect?.hasAttribute('fill')).toBe(false);
    expect(rect?.hasAttribute('stroke')).toBe(false);
    expect(rect?.getAttribute('stroke-width')).toBe('2px');
  });
});

describe('resolveContextPaints', () => {
  it('把 marker 上的 context-stroke 解析成引用元素的 stroke', () => {
    const svg = parseSvg(
      `<svg xmlns="${SVG_XMLNS}"><defs><marker id="arrow"><path id="head" fill="context-stroke"/></marker></defs><path id="edge" marker-end="url(#arrow)"/></svg>`
    );
    resolveContextPaints(svg, (el) => (el.id === 'edge' ? { stroke: 'rgb(10, 20, 30)' } : {}));
    expect(svg.querySelector('#head')?.getAttribute('fill')).toBe('rgb(10, 20, 30)');
  });

  it('没有引用元素时 context-stroke / context-fill 兜底为 #333333', () => {
    const svg = parseSvg(
      `<svg xmlns="${SVG_XMLNS}"><defs><marker id="arrow"><path id="head" fill="context-stroke" stroke="context-fill"/></marker></defs></svg>`
    );
    resolveContextPaints(svg, () => ({}));
    const head = svg.querySelector('#head');
    expect(head?.getAttribute('fill')).toBe('#333333');
    expect(head?.getAttribute('stroke')).toBe('#333333');
  });

  it('内联并解析后的序列化结果不含 context-stroke、context-fill 和 style 元素', () => {
    const svg = parseSvg(
      `<svg xmlns="${SVG_XMLNS}"><style>path{fill:context-stroke;stroke:context-fill}</style><defs><marker id="arrow"><path id="head" fill="context-stroke" stroke="context-fill"/></marker></defs><path id="edge" marker-end="url(#arrow)"/></svg>`
    );
    const read = (el: Element): Record<string, string> => {
      if (el.id === 'head') return { fill: 'context-stroke', stroke: 'context-fill' };
      if (el.id === 'edge') return { stroke: '#333333', fill: 'none', 'marker-end': 'url(#arrow)' };
      return {};
    };
    inlinePresentationAttrs(svg, read);
    resolveContextPaints(svg, read);
    removeSvgStyleElements(svg);
    const xml = new XMLSerializer().serializeToString(svg);
    expect(xml).not.toContain('context-stroke');
    expect(xml).not.toContain('context-fill');
    expect(xml).not.toMatch(/<style[\s>]/i);
    expect(svg.querySelector('#head')?.getAttribute('fill')).toBe('#333333');
  });

  it('同一 marker 被不同颜色引用时按 stroke 拆成各自的箭头', () => {
    const svg = parseSvg(
      `<svg xmlns="${SVG_XMLNS}"><defs><marker id="arrow"><path id="head" fill="context-stroke"/></marker></defs><path id="a" marker-end="url(#arrow)"/><path id="b" marker-end="url(#arrow)"/></svg>`
    );
    resolveContextPaints(svg, (el) => {
      if (el.id === 'a') return { stroke: 'rgb(255, 0, 0)' };
      if (el.id === 'b') return { stroke: 'rgb(0, 0, 255)' };
      return {};
    });
    expect(svg.querySelector('#head')?.getAttribute('fill')).toBe('rgb(255, 0, 0)');
    expect(svg.querySelector('#a')?.getAttribute('marker-end')).toBe('url(#arrow)');
    expect(svg.querySelector('#b')?.getAttribute('marker-end')).toBe('url(#arrow-1)');
    expect(svg.querySelector('#arrow-1 path')?.getAttribute('fill')).toBe('rgb(0, 0, 255)');
    expect(new XMLSerializer().serializeToString(svg)).not.toContain('context-stroke');
  });
});

describe('absolutizeEmTextPositions', () => {
  it('把 tspan 的 em y/dy 折成绝对 px，并写回父 text', () => {
    const svg = parseSvg(
      `<svg xmlns="${SVG_XMLNS}"><g transform="translate(390,8)"><text y="-10.1" font-size="16"><tspan x="0" y="-0.1em" dy="1.1em">订单仓</tspan></text></g></svg>`
    );
    absolutizeEmTextPositions(svg);
    const text = svg.querySelector('text');
    const tspan = svg.querySelector('tspan');
    expect(text?.getAttribute('y')).toBe('16');
    expect(tspan?.getAttribute('x')).toBe('0');
    expect(tspan?.getAttribute('y')).toBe('16');
    expect(tspan?.hasAttribute('dy')).toBe(false);
    const once = new XMLSerializer().serializeToString(svg);
    absolutizeEmTextPositions(svg);
    expect(new XMLSerializer().serializeToString(svg)).toBe(once);
  });

  it('没有 em、也没有 dy 的 px 坐标保持原样', () => {
    const svg = parseSvg(
      `<svg xmlns="${SVG_XMLNS}"><text y="12" font-size="16"><tspan x="4" y="12">Hi</tspan></text></svg>`
    );
    const before = new XMLSerializer().serializeToString(svg);
    absolutizeEmTextPositions(svg);
    expect(new XMLSerializer().serializeToString(svg)).toBe(before);
    expect(svg.querySelector('text')?.getAttribute('y')).toBe('12');
    expect(svg.querySelector('tspan')?.getAttribute('y')).toBe('12');
    expect(svg.querySelector('tspan')?.hasAttribute('dy')).toBe(false);
  });
});

describe('materializeMarkers', () => {
  it('按端点方向把 marker 烘焙成填充三角，并去掉 marker-end', () => {
    const svg = parseSvg(
      `<svg xmlns="${SVG_XMLNS}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs><path id="edge" d="M0 0 L100 0" marker-end="url(#arrow)" stroke="rgb(51, 51, 51)"/></svg>`
    );
    materializeMarkers(svg, () => ({ x: 100, y: 0, dx: 1, dy: 0 }));
    const edge = svg.querySelector('#edge');
    expect(edge?.hasAttribute('marker-end')).toBe(false);
    const arrows = [...svg.querySelectorAll('path')].filter(
      (el) => el.id !== 'edge' && !el.closest('marker')
    );
    expect(arrows).toHaveLength(1);
    expect(arrows[0].getAttribute('fill')).toBe('rgb(51, 51, 51)');
    expect(arrows[0].getAttribute('d')).toBe('M 96 -4 L 104 0 L 96 4 z');
  });

  it('实体化后序列化结果不再包含 marker-end', () => {
    const svg = parseSvg(
      `<svg xmlns="${SVG_XMLNS}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs><path id="edge" d="M0 0 L40 0" marker-end="url(&quot;#arrow&quot;)" stroke="#333"/></svg>`
    );
    materializeMarkers(svg, () => ({ x: 40, y: 0, dx: 1, dy: 0 }));
    expect(svg.querySelector('#edge')?.hasAttribute('marker-end')).toBe(false);
    expect(new XMLSerializer().serializeToString(svg)).not.toContain('marker-end=');
  });
});
