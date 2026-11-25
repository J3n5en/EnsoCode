import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  buildHtmlVizDocument,
  clampVizHeight,
  isHtmlVizLanguage,
  nextVizState,
  parseVizMessage,
  scriptSafeJson,
  VIZ_CSP,
  VIZ_INITIAL_STATE,
  VIZ_MAX_HEIGHT,
  VIZ_MIN_HEIGHT,
  VIZ_SANDBOX,
  VIZ_TOKEN_NAMES,
  vizTokens,
} from './htmlViz';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('isHtmlVizLanguage', () => {
  it('识别 html-viz / htmlviz，大小写不敏感', () => {
    for (const lang of ['html-viz', 'HTML-VIZ', 'htmlviz', 'HtmlViz']) {
      expect(isHtmlVizLanguage(lang)).toBe(true);
    }
  });

  it('普通 html 与其它语言不识别', () => {
    for (const lang of ['html', 'HTML', 'xhtml', 'viz', 'html-vizz', '', undefined]) {
      expect(isHtmlVizLanguage(lang)).toBe(false);
    }
  });
});

describe('安全边界', () => {
  it('CSP 默认全禁，只放内联样式脚本与 data 图片', () => {
    expect(VIZ_CSP).toContain("default-src 'none'");
    expect(VIZ_CSP).toContain('img-src data:');
    expect(VIZ_CSP).toContain("font-src 'none'");
    expect(VIZ_CSP).not.toContain('allow-same-origin');
    expect(VIZ_CSP).not.toMatch(/https?:|\*/);
  });

  it('sandbox 只有 allow-scripts', () => {
    expect(VIZ_SANDBOX).toBe('allow-scripts');
  });

  it('CSP meta 位于 head 最前', () => {
    const doc = buildHtmlVizDocument({ code: '<p>x</p>', theme: 'light' });
    const head = doc.slice(doc.indexOf('<head>') + '<head>'.length);
    expect(
      head.startsWith(`<meta http-equiv="Content-Security-Policy" content="${VIZ_CSP}">`)
    ).toBe(true);
  });

  it('脚本内 JSON 转义 </script 与 <!--，且仍可还原', () => {
    const value = { a: '</script><script>alert(1)</script>', b: '<!-- x -->', c: '\u2028' };
    const out = scriptSafeJson(value);
    expect(out).not.toMatch(/<\/script/i);
    expect(out).not.toContain('<!--');
    expect(JSON.parse(out)).toEqual(value);
  });

  it('壳页面：内层 iframe 只给 allow-scripts，CSP 默认全禁', () => {
    const shell = readFileSync(new URL('../../public/html-viz.html', import.meta.url), 'utf8');
    const sandboxes = [...shell.matchAll(/'sandbox',\s*'([^']*)'/g)].map((m) => m[1]);
    expect(sandboxes).toEqual([VIZ_SANDBOX]);
    expect(shell).toContain("default-src 'none'");
    expect(shell).not.toMatch(/allow-(same-origin|popups|forms|modals|top-navigation|downloads)/);
  });
});

describe('buildHtmlVizDocument', () => {
  it('注入主题标记、color-scheme 与 tokens，用户代码原样进 body', () => {
    const doc = buildHtmlVizDocument({ code: '<svg id="u"></svg>', theme: 'dark' });
    expect(doc).toContain('data-enso-theme="dark"');
    expect(doc).toContain('color-scheme:dark');
    for (const [name, value] of Object.entries(vizTokens('dark'))) {
      expect(doc).toContain(`"${name}":"${value}"`);
    }
    expect(doc).toContain('<body><svg id="u"></svg></body>');
  });

  it('浅色同样注入', () => {
    const doc = buildHtmlVizDocument({ code: '', theme: 'light' });
    expect(doc).toContain('data-enso-theme="light"');
    expect(doc).toContain(vizTokens('light')['--enso-viz-bg']);
  });
});

describe('vizTokens', () => {
  it('浅/深两套字段齐全', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(Object.keys(vizTokens(theme)).sort()).toEqual(
        VIZ_TOKEN_NAMES.map((n) => `--enso-viz-${n}`).sort()
      );
    }
  });

  it('浅色背景明显亮于深色，且都不是纯白 / 纯黑', () => {
    const light = vizTokens('light')['--enso-viz-bg'];
    const dark = vizTokens('dark')['--enso-viz-bg'];
    expect(luminance(light) - luminance(dark)).toBeGreaterThan(0.7);
    expect(light.toLowerCase()).not.toBe('#ffffff');
    expect(dark.toLowerCase()).not.toBe('#000000');
  });

  it('两套主题对比度：正文 ≥7，次要文字 ≥4.5，强调色 ≥3', () => {
    for (const theme of ['light', 'dark'] as const) {
      const t = vizTokens(theme);
      for (const bg of [t['--enso-viz-bg'], t['--enso-viz-surface']]) {
        expect(contrast(t['--enso-viz-fg'], bg)).toBeGreaterThanOrEqual(7);
        expect(contrast(t['--enso-viz-muted'], bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t['--enso-viz-accent'], bg)).toBeGreaterThanOrEqual(3);
        expect(contrast(t['--enso-viz-accent2'], bg)).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('clampVizHeight', () => {
  it('限制在 [80, 1200]，非法值取下限', () => {
    expect(clampVizHeight(0)).toBe(VIZ_MIN_HEIGHT);
    expect(clampVizHeight(79.9)).toBe(VIZ_MIN_HEIGHT);
    expect(clampVizHeight(80)).toBe(80);
    expect(clampVizHeight(300.2)).toBe(301);
    expect(clampVizHeight(1200)).toBe(1200);
    expect(clampVizHeight(5000)).toBe(VIZ_MAX_HEIGHT);
    expect(clampVizHeight(Number.NaN)).toBe(VIZ_MIN_HEIGHT);
    expect(clampVizHeight(Number.POSITIVE_INFINITY)).toBe(VIZ_MIN_HEIGHT);
  });
});

describe('parseVizMessage', () => {
  it('只认高度与错误两种消息', () => {
    expect(parseVizMessage({ type: 'enso-viz-height', height: 120 })).toEqual({
      type: 'enso-viz-height',
      height: 120,
    });
    expect(parseVizMessage({ type: 'enso-viz-error', message: 'boom' })).toEqual({
      type: 'enso-viz-error',
      message: 'boom',
    });
    expect(parseVizMessage({ type: 'enso-viz-height', height: '1' })).toBeNull();
    expect(parseVizMessage({ type: 'enso-viz-theme' })).toBeNull();
    expect(parseVizMessage(null)).toBeNull();
    expect(parseVizMessage('enso-viz-height')).toBeNull();
  });
});

describe('nextVizState', () => {
  it('超时只是占位：随后收到高度即恢复渲染', () => {
    const timedOut = nextVizState(VIZ_INITIAL_STATE, { type: 'enso-viz-timeout' });
    expect(timedOut).toEqual({ height: null, failure: { kind: 'timedOut' } });
    const recovered = nextVizState(timedOut, { type: 'enso-viz-height', height: 240 });
    expect(recovered).toEqual({ height: 240, failure: null });
  });

  it('脚本错误粘住：随后收到高度也不恢复', () => {
    const failed = nextVizState(VIZ_INITIAL_STATE, { type: 'enso-viz-error', message: 'boom' });
    expect(failed.failure).toEqual({ kind: 'error', message: 'boom' });
    expect(nextVizState(failed, { type: 'enso-viz-height', height: 240 })).toBe(failed);
  });

  it('已收到高度后不再超时；高度仍按边界收敛', () => {
    const sized = nextVizState(VIZ_INITIAL_STATE, { type: 'enso-viz-height', height: 5 });
    expect(sized).toEqual({ height: VIZ_MIN_HEIGHT, failure: null });
    expect(nextVizState(sized, { type: 'enso-viz-timeout' })).toBe(sized);
  });
});

describe('harness 脚本', () => {
  function bootHarness(theme: 'light' | 'dark') {
    const doc = buildHtmlVizDocument({ code: '', theme });
    const script = doc.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error('找不到 harness 脚本');
    const listeners = new Map<string, ((event: unknown) => void)[]>();
    const style = new Map<string, string>();
    const documentElement = {
      dataset: {} as Record<string, string>,
      style: {
        colorScheme: '',
        setProperty: (k: string, v: string) => style.set(k, v),
      },
    };
    const posted: unknown[] = [];
    const parent = { postMessage: (m: unknown) => posted.push(m) };
    const context = createContext({
      parent,
      document: { documentElement, body: null },
      addEventListener: (type: string, fn: (event: unknown) => void) =>
        listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      String,
      Object,
      Math,
    });
    runInContext(script, context);
    const emit = (type: string, event: unknown) => {
      for (const fn of listeners.get(type) ?? []) fn(event);
    };
    return { documentElement, style, posted, parent, emit };
  }

  it('启动即写入主题变量；收到父窗口主题消息就地切换', () => {
    const h = bootHarness('light');
    expect(h.documentElement.dataset.ensoTheme).toBe('light');
    expect(h.style.get('--enso-viz-bg')).toBe(vizTokens('light')['--enso-viz-bg']);
    h.emit('message', {
      source: h.parent,
      data: { type: 'enso-viz-theme', theme: 'dark', tokens: vizTokens('dark') },
    });
    expect(h.documentElement.dataset.ensoTheme).toBe('dark');
    expect(h.documentElement.style.colorScheme).toBe('dark');
    expect(h.style.get('--enso-viz-bg')).toBe(vizTokens('dark')['--enso-viz-bg']);
  });

  it('忽略非父窗口与未知 token', () => {
    const h = bootHarness('light');
    h.emit('message', {
      source: {},
      data: { type: 'enso-viz-theme', theme: 'dark', tokens: vizTokens('dark') },
    });
    h.emit('message', {
      source: h.parent,
      data: { type: 'enso-viz-theme', theme: 'dark', tokens: { color: 'red' } },
    });
    expect(h.style.get('--enso-viz-bg')).toBe(vizTokens('light')['--enso-viz-bg']);
    expect(h.style.has('color')).toBe(false);
  });

  it('脚本错误与未处理 rejection 上报', () => {
    const h = bootHarness('dark');
    h.emit('error', { message: 'x is not defined' });
    h.emit('unhandledrejection', { reason: new Error('nope') });
    expect(h.posted).toEqual([
      { type: 'enso-viz-error', message: 'x is not defined' },
      { type: 'enso-viz-error', message: 'nope' },
    ]);
  });
});
