/**
 * 启动快照：上次界面的静态副本（去掉脚本），启动时先盖在 renderer 上，数据到齐再淡出。
 *
 * 不缓存数据本身：renderer 的状态以桌面为准，拿旧数据起步再写回会覆盖桌面上更新过的内容。
 * 快照只读、不跑脚本，存在该构建的 SW 缓存里，桌面升级换构建时随旧缓存一起清掉。
 * 样式内联、用 srcdoc 挂载：不依赖 SW 拦截 iframe 导航（iOS 上沙箱 iframe 可能直连中继拿到空页面）。
 */

const SNAPSHOT_FILE = '__snapshot.html';
const CHARS_HEADER = 'x-desk-chars';
/** 盖着的上限：桌面不在线等情况下也不能一直挡住 */
const MAX_SNAPSHOT_MS = 20_000;
const SETTLED_MS = 2_500;
/** 文字太少的快照（存的时候 renderer 正在重载）盖上去只是一片空白 */
const MIN_SNAPSHOT_CHARS = 200;

export interface SnapshotProgress {
  elapsed: number;
  /** renderer 当前可见文字量 */
  liveChars: number;
  snapChars: number;
  settingsLoaded: boolean;
  /** renderer 文字量多久没变了 */
  stableFor: number;
  /** 时间线还在「正在读取历史」：文字量稳定也不算追上 */
  liveLoading: boolean;
}

export interface SnapshotSample {
  now: number;
  liveChars: number;
  settingsLoaded: boolean;
  liveLoading: boolean;
}

export function snapshotReady(p: SnapshotProgress): boolean {
  if (p.elapsed >= MAX_SNAPSHOT_MS) return true;
  if (!p.settingsLoaded || p.liveLoading) return false;
  return p.liveChars >= p.snapChars * 0.8 || p.stableFor >= SETTLED_MS;
}

/**
 * 跟踪快照何时可揭开：等待设置或读取历史期间不累计「已稳定」时长，
 * 否则网络握手耗时 >= SETTLED_MS 时会在设置刚到达、会话尚未渲染出的瞬间提前撤下快照。
 */
export function createSnapshotTracker(
  startedAt: number,
  snapChars: number
): (sample: SnapshotSample) => boolean {
  let lastChars = -1;
  let changedAt = startedAt;
  return (sample) => {
    if (!sample.settingsLoaded || sample.liveLoading || sample.liveChars !== lastChars) {
      lastChars = sample.liveChars;
      changedAt = sample.now;
    }
    return snapshotReady({
      elapsed: sample.now - startedAt,
      liveChars: sample.liveChars,
      snapChars,
      settingsLoaded: sample.settingsLoaded,
      stableFor: sample.now - changedAt,
      liveLoading: sample.liveLoading,
    });
  };
}

export function canSaveSnapshot(chars: number, liveLoading: boolean): boolean {
  return !liveLoading && chars >= MIN_SNAPSHOT_CHARS;
}

const snapshotUrl = (base: string) => `${location.origin}${base}/${SNAPSHOT_FILE}`;

/** 弹层、菜单是瞬时状态，留在快照里像卡住了 */
const TRANSIENT =
  'script, iframe, link[rel="modulepreload"], meta[http-equiv], [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-radix-popper-content-wrapper]';

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** 内联后样式的基准从 css 文件变成文档，相对 url() 要先按 css 文件位置解析 */
export function absolutizeCssUrls(css: string, sheetHref: string): string {
  return css.replace(CSS_URL, (whole, _quote: string, url: string) =>
    /^(?:[a-z][\w+.-]*:|\/|#)/i.test(url) ? whole : `url("${new URL(url, sheetHref).href}")`
  );
}

/** 把同源样式表替换成 <style>，快照不再需要另外请求 css */
function inlineStyles(doc: Document, clone: HTMLElement): void {
  const sheets = new Map<string, CSSStyleSheet>();
  for (const sheet of doc.styleSheets) if (sheet.href) sheets.set(sheet.href, sheet);
  for (const link of clone.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const href = new URL(link.getAttribute('href') ?? '', doc.baseURI).href;
    const sheet = sheets.get(href);
    if (!sheet) continue;
    let css = '';
    try {
      for (const rule of sheet.cssRules) css += `${rule.cssText}\n`;
    } catch {
      continue;
    }
    const style = doc.createElement('style');
    style.textContent = absolutizeCssUrls(css, href);
    link.replaceWith(style);
  }
}

export async function saveSnapshot(cacheName: string, base: string, doc: Document): Promise<void> {
  const body = doc.body;
  if (!body) return;
  const chars = body.textContent?.length ?? 0;
  const liveLoading = Boolean(doc.querySelector('[data-timeline-loading]'));
  if (!canSaveSnapshot(chars, liveLoading)) return;
  const marked: Element[] = [];
  for (const el of doc.querySelectorAll('*')) {
    if (el.scrollTop > 0 || el.scrollLeft > 0) {
      el.setAttribute('data-desk-scroll', `${el.scrollTop},${el.scrollLeft}`);
      marked.push(el);
    }
  }
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  for (const el of marked) el.removeAttribute('data-desk-scroll');
  for (const el of clone.querySelectorAll(TRANSIENT)) el.remove();
  for (const img of clone.querySelectorAll('img[src^="blob:"]')) img.removeAttribute('src');
  inlineStyles(doc, clone);
  const head = clone.querySelector('head');
  if (!head) return;
  const baseEl = doc.createElement('base');
  baseEl.href = `${base}/`;
  head.prepend(baseEl);
  const html = `<!doctype html>${clone.outerHTML}`;
  const cache = await caches.open(cacheName);
  await cache.put(
    snapshotUrl(base),
    new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', [CHARS_HEADER]: String(chars) },
    })
  );
}

/** 读出快照及其文字量（文字量用于判断 renderer 何时追上） */
export async function loadSnapshot(
  cacheName: string,
  base: string
): Promise<{ html: string; chars: number } | null> {
  try {
    const hit = await (await caches.open(cacheName)).match(snapshotUrl(base));
    if (!hit) return null;
    const chars = Number(hit.headers.get(CHARS_HEADER)) || 0;
    if (chars < MIN_SNAPSHOT_CHARS) return null;
    return { html: await hit.text(), chars };
  } catch {
    return null;
  }
}

/** 快照 iframe：沙箱不允许脚本；载入后恢复各滚动区域的位置 */
export function mountSnapshot(container: HTMLElement, html: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = 'snapshot';
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.addEventListener(
    'load',
    () => {
      const doc = iframe.contentDocument;
      if (!doc) return;
      for (const el of doc.querySelectorAll('[data-desk-scroll]')) {
        const [top, left] = (el.getAttribute('data-desk-scroll') ?? '').split(',').map(Number);
        el.scrollTop = top || 0;
        el.scrollLeft = left || 0;
      }
    },
    { once: true }
  );
  iframe.srcdoc = html;
  container.appendChild(iframe);
  return iframe;
}

const READS_FILE = '__reads.json';
/** 持久化的只读结果上限（字符）：设置 + 当前会话历史尾窗足够 */
const READS_BUDGET = 4_000_000;

type ReadEntry = { h: string; json: string };

/** 只读缓存（按 hash 的设置/历史等）序列化：从最近写入的往前保留，超预算丢最旧的 */
export function packReads(reads: Map<string, ReadEntry>, budget = READS_BUDGET): string {
  const kept: [string, ReadEntry][] = [];
  let chars = 0;
  for (const item of [...reads].reverse()) {
    chars += item[0].length + item[1].json.length;
    if (chars > budget) break;
    kept.unshift(item);
  }
  return JSON.stringify(kept);
}

export function unpackReads(text: string): Map<string, ReadEntry> {
  const reads = new Map<string, ReadEntry>();
  try {
    const list: unknown = JSON.parse(text);
    if (!Array.isArray(list)) return reads;
    for (const item of list) {
      const [key, value] = Array.isArray(item) ? item : [];
      const entry = value as Partial<ReadEntry> | undefined;
      if (typeof key === 'string' && typeof entry?.h === 'string' && typeof entry.json === 'string')
        reads.set(key, { h: entry.h, json: entry.json });
    }
  } catch {}
  return reads;
}

const readsUrl = (base: string) => `${location.origin}${base}/${READS_FILE}`;

/** 下次启动时 shim 带着 hash 去问，内容没变宿主只回「没变」，不必再经中继下载 */
export async function saveReads(
  cacheName: string,
  base: string,
  reads: Map<string, ReadEntry>
): Promise<void> {
  if (reads.size === 0) return;
  const cache = await caches.open(cacheName);
  await cache.put(
    readsUrl(base),
    new Response(packReads(reads), { headers: { 'Content-Type': 'application/json' } })
  );
}

export async function loadReads(cacheName: string, base: string): Promise<Map<string, ReadEntry>> {
  try {
    const hit = await (await caches.open(cacheName)).match(readsUrl(base));
    return hit ? unpackReads(await hit.text()) : new Map();
  } catch {
    return new Map();
  }
}

/** 删掉已不在配对列表里的设备的快照与只读缓存 */
export async function pruneSnapshots(cacheName: string, pairIds: string[]): Promise<void> {
  try {
    const keep = new Set(pairIds.map((id) => `/desk/r/${encodeURIComponent(id)}/`));
    const cache = await caches.open(cacheName);
    for (const request of await cache.keys()) {
      const path = new URL(request.url).pathname;
      const local = path.endsWith(`/${SNAPSHOT_FILE}`) || path.endsWith(`/${READS_FILE}`);
      if (local && ![...keep].some((p) => path.startsWith(p))) await cache.delete(request);
    }
  } catch {}
}
