export type VizTheme = 'light' | 'dark';

export const VIZ_SANDBOX = 'allow-scripts';
export const VIZ_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src 'none'";
export const VIZ_MIN_HEIGHT = 80;
export const VIZ_MAX_HEIGHT = 1200;
export const VIZ_READY_TIMEOUT_MS = 5000;

export const VIZ_TOKEN_NAMES = [
  'bg',
  'surface',
  'fg',
  'muted',
  'border',
  'accent',
  'accent2',
  'grid',
] as const;
type VizTokenName = (typeof VIZ_TOKEN_NAMES)[number];
export type VizTokens = Record<`--enso-viz-${VizTokenName}`, string>;

/** 取自 Enso 内置主题的 sunken / text / accent 色阶；浅色底不用纯白，深色底不用纯黑 */
const TOKENS: Record<VizTheme, Record<VizTokenName, string>> = {
  light: {
    bg: '#f7f7f9',
    surface: '#fcfcfd',
    fg: '#1d1c23',
    muted: '#5a5966',
    border: '#dcdbe3',
    accent: '#5b4bd5',
    accent2: '#0b7f72',
    grid: '#e7e6ec',
  },
  dark: {
    bg: '#1e1e23',
    surface: '#27272d',
    fg: '#ececf1',
    muted: '#a9a8b4',
    border: '#3a3a43',
    accent: '#a194ff',
    accent2: '#3ccbb5',
    grid: '#2f2f36',
  },
};

export function vizTokens(theme: VizTheme): VizTokens {
  const set = TOKENS[theme];
  return Object.fromEntries(
    VIZ_TOKEN_NAMES.map((name) => [`--enso-viz-${name}`, set[name]])
  ) as VizTokens;
}

export function isHtmlVizLanguage(lang: string | undefined): boolean {
  const value = lang?.toLowerCase();
  return value === 'html-viz' || value === 'htmlviz';
}

export function clampVizHeight(height: number): number {
  if (!Number.isFinite(height)) return VIZ_MIN_HEIGHT;
  return Math.min(VIZ_MAX_HEIGHT, Math.max(VIZ_MIN_HEIGHT, Math.ceil(height)));
}

/** 嵌进 <script> 的 JSON：< 与行分隔符转义，防止 </script、<!-- 提前闭合脚本 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export type VizMessage =
  | { type: 'enso-viz-height'; height: number }
  | { type: 'enso-viz-error'; message: string };

export function parseVizMessage(data: unknown): VizMessage | null {
  if (!data || typeof data !== 'object') return null;
  const msg = data as Record<string, unknown>;
  if (msg.type === 'enso-viz-height' && typeof msg.height === 'number')
    return { type: msg.type, height: msg.height };
  if (msg.type === 'enso-viz-error')
    return { type: msg.type, message: String(msg.message ?? '').slice(0, 500) };
  return null;
}

export function vizThemeMessage(theme: VizTheme) {
  return { type: 'enso-viz-theme', theme, tokens: vizTokens(theme) } as const;
}

export type VizFailure = { kind: 'timedOut' } | { kind: 'error'; message: string };

export interface VizState {
  height: number | null;
  failure: VizFailure | null;
}

export const VIZ_INITIAL_STATE: VizState = { height: null, failure: null };

export type VizEvent = VizMessage | { type: 'enso-viz-timeout' };

/** 超时只是占位（脚本可能慢或还没上报高度），收到高度即恢复；脚本错误则粘住不再尝试渲染 */
export function nextVizState(state: VizState, event: VizEvent): VizState {
  if (event.type === 'enso-viz-timeout')
    return state.height !== null || state.failure !== null
      ? state
      : { ...state, failure: { kind: 'timedOut' } };
  if (event.type === 'enso-viz-height')
    return state.failure?.kind === 'error'
      ? state
      : { height: clampVizHeight(event.height), failure: null };
  return { ...state, failure: { kind: 'error', message: event.message } };
}

const BASE_CSS =
  'html,body{margin:0;background:var(--enso-viz-bg);color:var(--enso-viz-fg)}' +
  'body{padding:12px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}';

/** 跑在用户代码之前：写主题变量、就地换主题、上报高度与脚本错误 */
function harness(initial: { theme: VizTheme; tokens: VizTokens }): string {
  return `(()=>{
const names=${scriptSafeJson(Object.keys(initial.tokens))};
const post=(m)=>{try{parent.postMessage(m,'*')}catch(_){}};
const apply=(theme,tokens)=>{const r=document.documentElement;r.dataset.ensoTheme=theme;r.style.colorScheme=theme;for(const k of names){if(typeof tokens[k]==='string')r.style.setProperty(k,tokens[k])}};
const init=${scriptSafeJson(initial)};
apply(init.theme,init.tokens);
addEventListener('message',(e)=>{const d=e.data;if(e.source!==parent||!d||d.type!=='enso-viz-theme'||(d.theme!=='light'&&d.theme!=='dark')||!d.tokens||typeof d.tokens!=='object')return;apply(d.theme,d.tokens)});
addEventListener('error',(e)=>post({type:'enso-viz-error',message:String((e&&e.message)||'Script error')}));
addEventListener('unhandledrejection',(e)=>{const r=e&&e.reason;post({type:'enso-viz-error',message:String((r&&r.message)||r||'Unhandled rejection')})});
let last=-1;
const report=()=>{const b=document.body;if(!b)return;const s=getComputedStyle(b);const h=Math.ceil(b.getBoundingClientRect().height+parseFloat(s.marginTop)+parseFloat(s.marginBottom));if(h!==last){last=h;post({type:'enso-viz-height',height:h})}};
addEventListener('DOMContentLoaded',()=>{report();if(typeof ResizeObserver==='function')new ResizeObserver(report).observe(document.body)});
addEventListener('load',report);
})();`;
}

/** 用户 HTML 不做清洗，隔离靠 sandbox="allow-scripts" + CSP */
export function buildHtmlVizDocument({ code, theme }: { code: string; theme: VizTheme }): string {
  const script = harness({ theme, tokens: vizTokens(theme) });
  return (
    `<!doctype html><html lang="en" data-enso-theme="${theme}" style="color-scheme:${theme}"><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${VIZ_CSP}">` +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<style>${BASE_CSS}</style><script>${script}</script></head><body>${code}</body></html>`
  );
}
