/**
 * 触屏键盘避让：iOS 弹键盘时布局视口不变，只有 visualViewport 变矮、并可能整体上推（offsetTop）。
 * 把根容器摆到可见区上（top = offsetTop，高 = 可见高度），输入框就贴着键盘、列表相应变短。
 *
 * 只在「确有输入框聚焦且可见区确实被压掉一截」时生效，并且只加 class + 变量，不改写原有高度：
 * 之前按比例猜键盘、把高度钉成像素值，在 standalone 下误判后一直留白（见 big-question/ios-pwa-header-blur.md）。
 * 判不准时一律回到原布局。
 */

/** 低于此高度不算键盘（浏览器工具栏伸缩、外接键盘的候选条） */
export const MIN_KEYBOARD_PX = 120;
export const KEYBOARD_CLASS = 'kb-open';

export interface ViewportSample {
  /** 布局视口高度（window.innerHeight，键盘弹起时 iOS 不变） */
  layoutHeight: number;
  height: number;
  offsetTop: number;
  scale: number;
  editing: boolean;
}

export interface KeyboardFrame {
  /** 可见区在布局视口里的上沿（iOS 会把页面上推） */
  top: number;
  height: number;
}

export function keyboardFrame(s: ViewportSample): KeyboardFrame | null {
  if (!s.editing || !(s.height > 0) || Math.abs(s.scale - 1) > 0.01) return null;
  if (s.layoutHeight - s.height < MIN_KEYBOARD_PX) return null;
  return { top: Math.max(0, Math.round(s.offsetTop)), height: Math.round(s.height) };
}

const TEXT_INPUT =
  /^(text|search|url|tel|email|password|number|date|datetime-local|month|time|week)$/i;

/** 聚焦的是可输入元素（穿过同源 iframe：完整版输入框在 renderer iframe 里） */
export function editableFocused(doc: Document): boolean {
  let el: Element | null = doc.activeElement;
  for (let depth = 0; el && el.tagName === 'IFRAME' && depth < 4; depth++) {
    try {
      el = (el as HTMLIFrameElement).contentDocument?.activeElement ?? null;
    } catch {
      return false;
    }
  }
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return !(el as HTMLTextAreaElement).readOnly;
  if (el.tagName === 'INPUT') {
    const input = el as HTMLInputElement;
    return TEXT_INPUT.test(input.type || 'text') && !input.readOnly;
  }
  return (el as HTMLElement).isContentEditable === true;
}

/** 只有触屏（无悬停、粗指针）才接管；桌面和鼠标设备零变化 */
export function touchOnly(win: Pick<Window, 'matchMedia'>): boolean {
  try {
    return win.matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch {
    return false;
  }
}

export interface KeyboardInset {
  /** iframe 里的焦点事件不冒泡到父页面：每个同源 iframe 加载后挂上 */
  watchDocument(doc: Document): void;
  sync(): void;
}

export function installKeyboardInset(win: Window): KeyboardInset | null {
  const viewport = win.visualViewport;
  if (!viewport || !touchOnly(win)) return null;
  const doc = win.document;
  const root = doc.documentElement;
  let frame = 0;
  let open = false;
  const apply = () => {
    frame = 0;
    const next = keyboardFrame({
      layoutHeight: win.innerHeight,
      height: viewport.height,
      offsetTop: viewport.offsetTop,
      scale: viewport.scale,
      editing: editableFocused(doc),
    });
    if (next) {
      root.style.setProperty('--kb-top', `${next.top}px`);
      root.style.setProperty('--kb-height', `${next.height}px`);
      root.classList.add(KEYBOARD_CLASS);
      open = true;
      return;
    }
    if (!open) return;
    open = false;
    root.classList.remove(KEYBOARD_CLASS);
    for (const name of ['--kb-top', '--kb-height']) root.style.removeProperty(name);
    // 键盘收起后 iOS 可能留着上推的滚动，不归零就是底部一截空白
    if (win.scrollY !== 0 || win.scrollX !== 0) win.scrollTo(0, 0);
  };
  const sync = () => {
    if (!frame) frame = win.requestAnimationFrame(apply);
  };
  viewport.addEventListener('resize', sync);
  viewport.addEventListener('scroll', sync);
  const watched = new WeakSet<Document>();
  const watchDocument = (target: Document) => {
    if (watched.has(target)) return;
    watched.add(target);
    // 失焦后 visualViewport 未必再触发 resize，显式重算；键盘动画结束再补一次
    const later = () => {
      sync();
      win.setTimeout(sync, 300);
    };
    target.addEventListener('focusin', later, true);
    target.addEventListener('focusout', later, true);
  };
  watchDocument(doc);
  return { watchDocument, sync };
}
