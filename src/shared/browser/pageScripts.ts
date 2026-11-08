/**
 * 注入 guest 页执行的脚本源码（`webContents.executeJavaScript`）。
 * 快照只收视口内可见控件 + 可见正文，并打 `data-enso-ref` / kind。
 * 点 / 填前做遮挡检查，动作后短等待。拖拽坐标在页内解析，指针由 Main sendInputEvent 发。
 */

import { DESIGN_CSS_PROPERTIES, DESIGN_CSS_TARGET_ATTRIBUTE } from './designAnnotation';
import { DESIGN_SCRIBBLE_HOLD_MS, DESIGN_SCRIBBLE_MOVE_PX } from './designMode';

const REF_ATTR = 'data-enso-ref';
const LOCK_OVERLAY_ID = 'enso-browser-lock-overlay';

export const PAGE_SETTLE_FRAME_MS = 50;
export const PAGE_SETTLE_COMBOBOX_MS = 200;

export const PAGE_SNAPSHOT_SCRIPT = `(() => {
  const REF_ATTR = ${JSON.stringify(REF_ATTR)};
  const MAX = 400;
  const MAX_TEXT = 2000;
  const ROLES = ['button','link','checkbox','radio','tab','menuitem','switch','textbox','combobox','option','slider','searchbox','spinbutton'];
  for (const old of document.querySelectorAll('[' + REF_ATTR + ']')) old.removeAttribute(REF_ATTR);
  if (!document.body) return [];
  const visible = (el) => {
    if (!el || el.closest('[aria-hidden="true"],[inert]')) return false;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const inViewport = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    return r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  };
  const isSecret = (el) => {
    const type = (el.type || '').toLowerCase();
    return type === 'file' || type === 'hidden';
  };
  const isInteractive = (el) => {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.matches(':disabled') || el.closest('[aria-disabled="true"]')) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'option') return false;
    if (tag === 'a' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
    if (tag === 'input') return !isSecret(el);
    if (el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1')) return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute('role');
    return ROLES.includes(role || '');
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (text) return text;
    }
    if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => l.textContent || '').join(' ').trim();
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') return el.getAttribute('alt') || '';
    if (tag === 'input' && (el.type === 'submit' || el.type === 'button')) return el.value || '';
    if (tag === 'input' || tag === 'textarea') return el.getAttribute('placeholder') || el.getAttribute('name') || '';
    const text = (el.innerText || el.textContent || '').trim();
    return text.length > 200 ? text.slice(0, 200) + '…' : text;
  };
  const valueOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) return el.checked ? 'checked' : '';
    if (tag === 'input' && el.type !== 'password') return el.value || '';
    if (tag === 'textarea') return el.value || '';
    if (tag === 'select') return el.selectedOptions[0]?.textContent || '';
    if (tag === 'a') return el.getAttribute('href') || '';
    return '';
  };
  const kindOf = (el, role) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return 'select';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'click';
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || el.isContentEditable) return 'fill';
    if (role === 'combobox' && (tag === 'input' || tag === 'textarea')) return 'fill';
    return 'click';
  };
  const out = [];
  const words = [];
  let length = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node;
  while ((node = walker.nextNode()) && length < MAX_TEXT) {
    const value = (node.textContent || '').trim();
    const parent = node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template')) continue;
    if (!visible(parent)) continue;
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
      words.push(value);
      length += value.length;
    }
  }
  const excerpt = words.join(' ').replace(/\\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (excerpt) out.push({ role: 'text', name: excerpt, depth: 0 });
  let counter = 0;
  for (const el of document.querySelectorAll('a,button,input,select,textarea,summary,[contenteditable="true"],[onclick],[tabindex],[role]')) {
    if (out.length >= MAX) break;
    if (!isInteractive(el) || !visible(el) || !inViewport(el)) continue;
    const role = roleOf(el);
    const kind = kindOf(el, role);
    const ref = 'e' + (++counter);
    el.setAttribute(REF_ATTR, ref);
    const entry = { role, name: nameOf(el), depth: 0, ref, kind };
    const value = valueOf(el);
    if (value) entry.value = value.length > 200 ? value.slice(0, 200) + '…' : value;
    out.push(entry);
  }
  return out;
})()`;

const findByRef = (ref: string) =>
  `document.querySelector('[${REF_ATTR}=' + ${JSON.stringify(JSON.stringify(ref))} + ']')`;

const withLockHiddenSrc = `const withLockHidden = (fn) => {
  const overlay = document.getElementById(${JSON.stringify(LOCK_OVERLAY_ID)});
  if (overlay) overlay.style.display = 'none';
  try { return fn(); } finally { if (overlay) overlay.style.display = ''; }
};`;

const hittableSrc = `const hittable = (el) => {
  if (!el || !el.isConnected) return 'stale';
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return 'covered';
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const hit = withLockHidden(() => document.elementFromPoint(x, y));
  if (!(hit instanceof Node)) return 'covered';
  if (hit === el || el.contains(hit)) return 'ok';
  return 'covered';
};`;

const settleFramesSrc = `const settleFrames = () => Promise.race([
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  new Promise((r) => setTimeout(r, ${PAGE_SETTLE_FRAME_MS})),
]);`;

const settleComboboxSrc = `const settleCombobox = async (el) => {
  const combobox = el && (
    el.tagName === 'SELECT' ||
    el.getAttribute('role') === 'combobox' ||
    (el instanceof HTMLInputElement && (el.getAttribute('aria-autocomplete') === 'list' || el.getAttribute('aria-autocomplete') === 'both'))
  );
  if (combobox) {
    const deadline = performance.now() + ${PAGE_SETTLE_COMBOBOX_MS};
    while (performance.now() < deadline) {
      await new Promise((r) => requestAnimationFrame(r));
      if (el.getAttribute('aria-expanded') === 'true') break;
    }
    return;
  }
  await settleFrames();
};`;

/** 返回 'ok' | 'stale' | 'covered'；点击前做遮挡检查，点击后等两帧。 */
export const pageClickScript = (ref: string): string => `(async () => {
  ${withLockHiddenSrc}
  ${hittableSrc}
  ${settleFramesSrc}
  const el = ${findByRef(ref)};
  if (!el) return 'stale';
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const gate = hittable(el);
  if (gate !== 'ok') return gate;
  if (typeof el.focus === 'function') el.focus();
  el.click();
  await settleFrames();
  return 'ok';
})()`;

/** 返回 'ok' | 'stale' | 'covered' | 'not-editable'；填完后 combobox 最多等 200ms。 */
export const pageTypeScript = (
  ref: string,
  text: string,
  submit: boolean
): string => `(async () => {
  ${withLockHiddenSrc}
  ${hittableSrc}
  ${settleFramesSrc}
  ${settleComboboxSrc}
  const el = ${findByRef(ref)};
  if (!el) return 'stale';
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const gate = hittable(el);
  if (gate !== 'ok') return gate;
  el.focus();
  const text = ${JSON.stringify(text)};
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
  } else if (el instanceof HTMLSelectElement) {
    const option = Array.from(el.options).find((o) => o.value === text || o.textContent.trim() === text);
    if (!option) return 'not-editable';
    el.value = option.value;
  } else if (el.isContentEditable) {
    el.textContent = text;
  } else {
    return 'not-editable';
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (${submit}) {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
  }
  await settleCombobox(el);
  return 'ok';
})()`;

/** 盖在 guest 页上吞掉用户指针；agent 的 element.click() 不经过这层。 */
export const PAGE_LOCK_OVERLAY_SCRIPT = `(() => {
  const ID = ${JSON.stringify(LOCK_OVERLAY_ID)};
  if (document.getElementById(ID)) return 'ok';
  const el = document.createElement('div');
  el.id = ID;
  Object.assign(el.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    background: 'transparent',
    cursor: 'not-allowed',
  });
  const block = (e) => { e.stopPropagation(); e.preventDefault(); };
  for (const type of ['click','mousedown','mouseup','pointerdown','pointerup','wheel','touchstart','contextmenu']) {
    el.addEventListener(type, block, true);
  }
  document.documentElement.appendChild(el);
  return 'ok';
})()`;

/** 幂等；只有确认节点真的没了才返回 'ok'，宿主据此才敢落 locked=false。 */
export const PAGE_UNLOCK_OVERLAY_SCRIPT = `(() => {
  const ID = ${JSON.stringify(LOCK_OVERLAY_ID)};
  for (let i = 0; i < 8; i++) {
    const el = document.getElementById(ID);
    if (!el) return 'ok';
    el.remove();
  }
  return document.getElementById(ID) ? 'stuck' : 'ok';
})()`;

export const pageSelectOptionScript = (ref: string, values: string[]): string => `(async () => {
  ${settleFramesSrc}
  const el = ${findByRef(ref)};
  if (!el) return 'stale';
  if (!(el instanceof HTMLSelectElement)) return 'not-select';
  const values = ${JSON.stringify(values)};
  if (el.multiple) {
    for (const opt of el.options) opt.selected = values.includes(opt.value) || values.includes(opt.textContent.trim());
  } else {
    const want = values[0];
    const opt = Array.from(el.options).find((o) => o.value === want || o.textContent.trim() === want);
    if (!opt) return 'not-found';
    el.value = opt.value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await settleFrames();
  return 'ok';
})()`;

export const pagePressKeyScript = (key: string): string => `(async () => {
  ${settleFramesSrc}
  const el = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const key = ${JSON.stringify(key)};
  const init = { key, code: key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  if (key === 'Enter' && el instanceof HTMLElement && el.form && typeof el.form.requestSubmit === 'function') {
    el.form.requestSubmit();
  }
  await settleFrames();
  return 'ok';
})()`;

export const pageScrollScript = (opts: {
  ref?: string;
  direction?: string;
  amount?: number;
}): string => {
  const amount = typeof opts.amount === 'number' ? opts.amount : 400;
  const dir = opts.direction === 'up' ? -1 : 1;
  if (opts.ref) {
    return `(async () => {
      ${settleFramesSrc}
      const el = ${findByRef(opts.ref)};
      if (!el) return 'stale';
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.scrollBy({ top: ${dir * amount}, behavior: 'instant' });
      await settleFrames();
      return 'ok';
    })()`;
  }
  return `(async () => {
    ${settleFramesSrc}
    window.scrollBy({ top: ${dir * amount}, behavior: 'instant' });
    await settleFrames();
    return 'ok';
  })()`;
};

/** 锁定遮罩会挡住 elementFromPoint；命中测试期间临时隐藏。 */
const hitTest = `(x, y) => {
  const overlay = document.getElementById(${JSON.stringify(LOCK_OVERLAY_ID)});
  if (overlay) overlay.style.display = 'none';
  try { return document.elementFromPoint(x, y); } finally { if (overlay) overlay.style.display = ''; }
}`;

export const pageClickXyScript = (x: number, y: number): string => `(async () => {
  ${settleFramesSrc}
  const x = ${JSON.stringify(x)}, y = ${JSON.stringify(y)};
  const el = (${hitTest})(x, y);
  if (!(el instanceof HTMLElement)) return 'miss';
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
  el.click();
  await settleFrames();
  return 'ok';
})()`;

export const pageHighlightScript = (ref: string): string => `(() => {
  const el = ${findByRef(ref)};
  if (!el) return 'stale';
  const prev = el.getAttribute('style');
  el.style.outline = '3px solid #f59e0b';
  el.style.outlineOffset = '2px';
  setTimeout(() => {
    if (prev == null) el.removeAttribute('style');
    else el.setAttribute('style', prev);
  }, 2000);
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  return 'ok';
})()`;

export const pageBoundingBoxScript = (ref: string): string => `(() => {
  const el = ${findByRef(ref)};
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`;

export const pageLockOverlayDisplayScript = (hidden: boolean): string => `(() => {
  const el = document.getElementById(${JSON.stringify(LOCK_OVERLAY_ID)});
  if (el) el.style.display = ${hidden ? JSON.stringify('none') : JSON.stringify('')};
  return 'ok';
})()`;

export const PAGE_SETTLE_FRAMES_SCRIPT = `(async () => {
  ${settleFramesSrc}
  await settleFrames();
  return 'ok';
})()`;

/** 解析坐标，并派发同一份 DataTransfer 的 HTML5 拖放事件（the-internet 一类原生 DnD）。 */
export const pageDragPointsScript = (
  from: { ref?: string; x?: number; y?: number },
  to: { ref?: string; x?: number; y?: number }
): string => `(() => {
  const point = (spec) => {
    if (spec.ref) {
      const el = document.querySelector('[${REF_ATTR}=' + JSON.stringify(spec.ref) + ']');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { el, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return { el: document.elementFromPoint(spec.x, spec.y), x: spec.x, y: spec.y };
  };
  const from = point(${JSON.stringify(from)});
  const to = point(${JSON.stringify(to)});
  if (!from || !to) return 'stale';
  const start = from.el instanceof Element ? from.el : document.elementFromPoint(from.x, from.y);
  const end = to.el instanceof Element ? to.el : document.elementFromPoint(to.x, to.y);
  if (start instanceof Element && end instanceof Element) {
    const dt = new DataTransfer();
    try { dt.setData('text/plain', start.id || (start.textContent || '').trim() || 'enso-drag'); } catch {}
    dt.effectAllowed = 'all';
    const fire = (el, type, x, y) => {
      el.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        dataTransfer: dt,
        view: window,
      }));
    };
    fire(start, 'dragstart', from.x, from.y);
    fire(end, 'dragenter', to.x, to.y);
    fire(end, 'dragover', to.x, to.y);
    fire(end, 'drop', to.x, to.y);
    fire(start, 'dragend', to.x, to.y);
  }
  return { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } };
})()`;

const DESIGN_MODE_ROOT_ID = 'enso-design-mode-root';
export const DESIGN_MODE_BINDING = 'ensoDesignMode';

/** 顶框注入圈选层；已注入则只重新 enable。身份用 WeakMap，不写 DOM 属性。 */
export const PAGE_DESIGN_MODE_ENABLE_SCRIPT = `(() => {
  if (window !== window.top) return 'frame';
  const ROOT_ID = ${JSON.stringify(DESIGN_MODE_ROOT_ID)};
  const BINDING = ${JSON.stringify(DESIGN_MODE_BINDING)};
  const HOLD_MS = ${DESIGN_SCRIBBLE_HOLD_MS};
  const MOVE_PX = ${DESIGN_SCRIBBLE_MOVE_PX};
  const send = (msg) => {
    try {
      const fn = window[BINDING];
      if (typeof fn === 'function') fn(JSON.stringify(msg));
    } catch {}
  };
  const existing = window.__ensoDesignMode;
  if (existing) {
    existing.setEnabled(true);
    return 'on';
  }
  let enabled = false;
  let hoverEl = null;
  let raf = 0;
  let picking = false;
  let phase = 'idle';
  let pressAt = 0;
  let pressX = 0;
  let pressY = 0;
  let pressHover = null;
  let holdTimer = 0;
  let strokes = [];
  let currentStroke = null;
  let freezeUrl = '';
  let pendingCommit = false;
  let cropOverride = null;
  let cropDrag = null;
  const root = document.createElement('div');
  root.id = ROOT_ID;
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483646',
    pointerEvents: 'none',
    overflow: 'hidden',
    contain: 'strict',
  });
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed',
    border: '2px solid #7c3aed',
    background: 'rgba(124,58,237,0.08)',
    display: 'none',
    pointerEvents: 'none',
  });
  root.appendChild(box);
  const hint = document.createElement('div');
  Object.assign(hint.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    top: '0',
    zIndex: '2',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 14px',
    fontSize: '13px',
    lineHeight: '18px',
    color: '#1e1b4b',
    background: '#ddd6fe',
    pointerEvents: 'none',
  });
  const hintLeft = document.createElement('span');
  hintLeft.textContent = '\u70b9\u51fb\u4efb\u610f\u5143\u7d20\u8fdb\u884c\u6807\u6ce8';
  const hintRight = document.createElement('span');
  hintRight.textContent = 'Esc \u9000\u51fa';
  hint.appendChild(hintLeft);
  hint.appendChild(hintRight);
  root.appendChild(hint);
  const tag = document.createElement('div');
  Object.assign(tag.style, {
    position: 'fixed',
    display: 'none',
    maxWidth: '240px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '11px',
    lineHeight: '16px',
    color: '#fafafa',
    background: '#5b21b6',
    pointerEvents: 'none',
  });
  root.appendChild(tag);
  const hoverTag = (el) => {
    const rawTag = (el.tagName || 'div').toLowerCase();
    const rawClass = typeof el.className === 'string' ? el.className : '';
    const parts = rawClass.split(/[ \\t\\n\\r]+/).filter((n) => n);
    let out = rawTag;
    for (const name of parts) {
      const next = out + '.' + name;
      if (next.length <= 32) { out = next; continue; }
      return out.length <= 29 ? out + '...' : out.slice(0, 29) + '...';
    }
    return out.length > 32 ? out.slice(0, 29) + '...' : out;
  };
  const freezeLayer = document.createElement('div');
  Object.assign(freezeLayer.style, {
    position: 'fixed',
    inset: '0',
    display: 'none',
    pointerEvents: 'auto',
    cursor: 'crosshair',
    overflow: 'hidden',
    contain: 'strict',
  });
  const lockFill = (el) => {
    el.style.setProperty('position', 'absolute', 'important');
    el.style.setProperty('inset', '0', 'important');
    el.style.setProperty('width', '100%', 'important');
    el.style.setProperty('height', '100%', 'important');
    el.style.setProperty('max-width', '100%', 'important');
    el.style.setProperty('max-height', '100%', 'important');
    el.style.setProperty('box-sizing', 'border-box', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
  };
  const freezeImg = document.createElement('img');
  freezeImg.alt = '';
  freezeImg.draggable = false;
  lockFill(freezeImg);
  freezeImg.style.setProperty('object-fit', 'fill', 'important');
  freezeImg.style.setProperty('image-rendering', 'auto', 'important');
  const draw = document.createElement('canvas');
  lockFill(draw);
  const cropCard = document.createElement('div');
  Object.assign(cropCard.style, {
    position: 'fixed',
    display: 'none',
    overflow: 'visible',
    borderRadius: '12px',
    background: '#fff',
    boxShadow: '0 18px 50px rgba(15,23,42,0.22), 0 0 0 1px rgba(15,23,42,0.06)',
    pointerEvents: 'auto',
    zIndex: '3',
  });
  const cropImg = document.createElement('canvas');
  Object.assign(cropImg.style, { width: '100%', display: 'block' });
  const actions = document.createElement('div');
  Object.assign(actions.style, {
    position: 'fixed',
    display: 'none',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '6px',
    zIndex: '4',
    pointerEvents: 'auto',
  });
  const mkBtn = (label, primary) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    Object.assign(b.style, {
      pointerEvents: 'auto',
      border: primary ? '0' : '1px solid rgba(255,255,255,0.55)',
      borderRadius: '999px',
      padding: '6px 12px',
      fontSize: '12px',
      lineHeight: '16px',
      cursor: 'pointer',
      background: primary ? '#ede9fe' : 'rgba(24,24,27,0.82)',
      color: primary ? '#5b21b6' : '#fafafa',
      boxShadow: primary ? 'none' : '0 4px 16px rgba(0,0,0,0.28)',
    });
    return b;
  };
  const addBtn = mkBtn('\u6dfb\u52a0\u5230\u5bf9\u8bdd', true);
  const cancelBtn = mkBtn('\u53d6\u6d88', false);
  actions.appendChild(cancelBtn);
  actions.appendChild(addBtn);
  const cropWrap = document.createElement('div');
  Object.assign(cropWrap.style, {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: '12px',
    cursor: 'move',
  });
  cropWrap.appendChild(cropImg);
  const mkHandle = (name, cursor, left, top, right, bottom) => {
    const h = document.createElement('div');
    h.dataset.handle = name;
    Object.assign(h.style, {
      position: 'absolute',
      width: '12px',
      height: '12px',
      borderRadius: '3px',
      background: '#fff',
      boxShadow: '0 0 0 1px rgba(15,23,42,0.2), 0 1px 4px rgba(15,23,42,0.2)',
      cursor,
      zIndex: '2',
      left, top, right, bottom,
    });
    cropWrap.appendChild(h);
    return h;
  };
  mkHandle('nw', 'nwse-resize', '-6px', '-6px', '', '');
  mkHandle('ne', 'nesw-resize', '', '-6px', '-6px', '');
  mkHandle('sw', 'nesw-resize', '-6px', '', '', '-6px');
  mkHandle('se', 'nwse-resize', '', '', '-6px', '-6px');
  cropCard.appendChild(cropWrap);
  freezeLayer.appendChild(freezeImg);
  freezeLayer.appendChild(draw);
  root.appendChild(freezeLayer);
  root.appendChild(cropCard);
  root.appendChild(actions);
  const mount = () => {
    if (!root.isConnected) document.documentElement.appendChild(root);
  };
  const hide = () => {
    box.style.visibility = 'hidden';
    hint.style.visibility = 'hidden';
    tag.style.visibility = 'hidden';
    freezeLayer.style.visibility = 'hidden';
  };
  const showChrome = () => {
    box.style.visibility = '';
    hint.style.visibility = '';
    tag.style.visibility = '';
  };
  const paint = (el) => {
    if (!el || !enabled || phase === 'annotating' || phase === 'freezing') {
      box.style.display = 'none';
      tag.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block',
      left: r.x + 'px',
      top: r.y + 'px',
      width: Math.max(0, r.width) + 'px',
      height: Math.max(0, r.height) + 'px',
    });
    tag.textContent = hoverTag(el);
    const tagTop = r.y >= 22 ? r.y - 20 : r.y + 2;
    Object.assign(tag.style, {
      display: 'block',
      left: Math.max(0, r.x) + 'px',
      top: tagTop + 'px',
    });
  };
  const skip = (el) => el === root || root.contains(el) || freezeLayer.contains(el);
  const meaningful = (el) => {
    if (!(el instanceof Element) || skip(el)) return null;
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (cur.id === ROOT_ID) return null;
      const tag = cur.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') return cur === el ? null : cur;
      const role = cur.getAttribute('role') || '';
      const interactive =
        /^(a|button|input|select|textarea|summary|label|img)$/.test(tag) ||
        cur.hasAttribute('onclick') ||
        cur.hasAttribute('tabindex') ||
        /button|link|textbox|checkbox|radio|menuitem/.test(role);
      if (interactive || cur.childElementCount === 0) return cur;
      cur = cur.parentElement;
    }
    return el instanceof Element ? el : null;
  };
  const cssPath = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 8) {
      const tag = cur.tagName.toLowerCase();
      if (cur.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(cur.id)) {
        parts.unshift(tag + '#' + cur.id);
        break;
      }
      const parent = cur.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
      const nth = same.indexOf(cur) + 1;
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + nth + ')' : tag);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const labelOf = (el) => {
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) {
      const value = (el.getAttribute('value') || el.innerText || '').trim();
      if (value) return value.replace(new RegExp('[ \\t\\n\\r]+', 'g'), ' ');
    }
    const text = (el.innerText || '').trim().replace(new RegExp('[ \\t\\n\\r]+', 'g'), ' ');
    return text ? text.slice(0, 80) : el.tagName.toLowerCase();
  };
  const payload = (el) => {
    const r = el.getBoundingClientRect();
    const className = typeof el.className === 'string' ? el.className : '';
    return {
      label: labelOf(el),
      path: cssPath(el),
      text: (el.innerText || '').trim().replace(new RegExp('[ \\t\\n\\r]+', 'g'), ' ').slice(0, 200),
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      className: className || undefined,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  };
  const flatten = () => {
    const out = [];
    for (const s of strokes) for (const p of s) out.push(p);
    return out;
  };
  const boundsOf = (pts) => {
    if (!pts.length) return null;
    let l = pts[0].x, r = pts[0].x, t = pts[0].y, b = pts[0].y;
    for (const p of pts) {
      l = Math.min(l, p.x); r = Math.max(r, p.x); t = Math.min(t, p.y); b = Math.max(b, p.y);
    }
    return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
  };
  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    draw.width = Math.max(1, Math.round(window.innerWidth * dpr));
    draw.height = Math.max(1, Math.round(window.innerHeight * dpr));
    const ctx = draw.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const paintStrokes = () => {
    const ctx = draw.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, draw.width, draw.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 3;
    for (const s of strokes) {
      if (s.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(s[0].x, s[0].y);
      for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y);
      ctx.stroke();
    }
  };
  const exitAnnotation = () => {
    phase = 'idle';
    strokes = [];
    currentStroke = null;
    freezeUrl = '';
    freezeImg.removeAttribute('src');
    freezeLayer.style.display = 'none';
    cropCard.style.display = 'none';
    actions.style.display = 'none';
    showChrome();
    paint(hoverEl);
    pendingCommit = false;
    cropOverride = null;
    cropDrag = null;
  };
  function defaultCrop() {
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const pts = flatten();
    const raw = boundsOf(pts) || { left: 0, top: 0, right: vw, bottom: vh, width: vw, height: vh };
    let left = raw.left - 48, right = raw.right + 48, top = raw.top - 48, bottom = raw.bottom + 48;
    const extraW = 120 - (right - left);
    if (extraW > 0) { left -= extraW / 2; right += extraW / 2; }
    const extraH = 120 - (bottom - top);
    if (extraH > 0) { top -= extraH / 2; bottom += extraH / 2; }
    const x = Math.max(0, Math.floor(left));
    const y = Math.max(0, Math.floor(top));
    return {
      x, y,
      width: Math.max(1, Math.min(vw, Math.ceil(right)) - x),
      height: Math.max(1, Math.min(vh, Math.ceil(bottom)) - y),
    };
  }
  function cropRect() {
    return cropOverride || defaultCrop();
  }
  function clampCrop(box) {
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const min = 48;
    let left = box.x, top = box.y, right = box.x + box.width, bottom = box.y + box.height;
    if (right - left < min) right = left + min;
    if (bottom - top < min) bottom = top + min;
    if (left < 0) { right -= left; left = 0; }
    if (top < 0) { bottom -= top; top = 0; }
    if (right > vw) { left -= right - vw; right = vw; }
    if (bottom > vh) { top -= bottom - vh; bottom = vh; }
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(vw, right);
    bottom = Math.min(vh, bottom);
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(1, Math.round(right - left)),
      height: Math.max(1, Math.round(bottom - top)),
    };
  }
  function applyCropDrag(event) {
    if (!cropDrag) return;
    const dx = event.clientX - cropDrag.x;
    const dy = event.clientY - cropDrag.y;
    const start = cropDrag.box;
    let next = { x: start.x, y: start.y, width: start.width, height: start.height };
    if (cropDrag.handle === 'move') {
      next = { x: start.x + dx, y: start.y + dy, width: start.width, height: start.height };
    } else {
      let left = start.x, top = start.y, right = start.x + start.width, bottom = start.y + start.height;
      if (cropDrag.handle.indexOf('w') >= 0) left += dx;
      if (cropDrag.handle.indexOf('e') >= 0) right += dx;
      if (cropDrag.handle.indexOf('n') >= 0) top += dy;
      if (cropDrag.handle.indexOf('s') >= 0) bottom += dy;
      next = { x: left, y: top, width: right - left, height: bottom - top };
    }
    cropOverride = clampCrop(next);
    showActions();
  }
  function paintCrop(target, crop) {
    const iw = freezeImg.naturalWidth || crop.width;
    const ih = freezeImg.naturalHeight || crop.height;
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const sx = iw / vw;
    const sy = ih / vh;
    const srcX = Math.max(0, Math.round(crop.x * sx));
    const srcY = Math.max(0, Math.round(crop.y * sy));
    const srcW = Math.max(1, Math.round(crop.width * sx));
    const srcH = Math.max(1, Math.round(crop.height * sy));
    target.width = srcW;
    target.height = srcH;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, srcW, srcH);
    try { ctx.drawImage(freezeImg, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH); } catch {}
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 3 * ((sx + sy) / 2);
    for (const s of strokes) {
      if (s.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo((s[0].x - crop.x) * sx, (s[0].y - crop.y) * sy);
      for (let i = 1; i < s.length; i++) ctx.lineTo((s[i].x - crop.x) * sx, (s[i].y - crop.y) * sy);
      ctx.stroke();
    }
  }
  function composeImage() {
    const crop = cropRect();
    const c = document.createElement('canvas');
    paintCrop(c, crop);
    const url = c.toDataURL('image/png');
    return url.slice(url.indexOf(',') + 1);
  }
  function groundedEl() {
    const pts = flatten();
    const b = boundsOf(pts);
    let el = null;
    if (b) {
      const prev = freezeLayer.style.display;
      freezeLayer.style.display = 'none';
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      freezeLayer.style.display = prev;
      el = meaningful(hit);
    }
    return el || pressHover || hoverEl;
  }
  function commitAnnotation() {
    const pts = flatten();
    if (pts.length < 2) {
      exitAnnotation();
      return;
    }
    send({ type: 'annotated', points: pts });
  }
  const inChrome = (el) => cropCard.contains(el) || actions.contains(el) || tag.contains(el);
  function showActions() {
    const crop = cropRect();
    paintCrop(cropImg, crop);
    cropImg.style.setProperty('width', crop.width + 'px', 'important');
    cropImg.style.setProperty('height', crop.height + 'px', 'important');
    Object.assign(cropCard.style, {
      display: 'block',
      left: crop.x + 'px',
      top: crop.y + 'px',
      width: crop.width + 'px',
      height: 'auto',
    });
    tag.style.display = 'none';
    const barW = 168;
    const barH = 36;
    let left = crop.x + crop.width - barW;
    let top = crop.y + crop.height + 10;
    if (left < 8) left = 8;
    if (left + barW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - barW - 8);
    if (top + barH > window.innerHeight - 8) top = Math.max(8, crop.y - barH - 10);
    Object.assign(actions.style, {
      display: 'flex',
      left: left + 'px',
      top: top + 'px',
    });
    freezeLayer.style.cursor = 'default';
    freezeLayer.style.background = 'rgba(15,23,42,0.28)';
    freezeImg.style.opacity = '0.35';
    draw.style.opacity = '0';
  }
  const showFrozen = (url) => {
    freezeUrl = url || '';
    if (!freezeUrl) {
      pendingCommit = false;
      exitAnnotation();
      return;
    }
    const ready = () => {
      phase = 'annotating';
      paintStrokes();
      if (currentStroke) return;
      pendingCommit = false;
      if (flatten().length >= 2) showActions();
      else exitAnnotation();
    };
    freezeImg.onload = ready;
    freezeImg.src = freezeUrl.indexOf('data:') === 0 ? freezeUrl : 'data:image/png;base64,' + freezeUrl;
    sizeCanvas();
    hide();
    freezeLayer.style.visibility = '';
    freezeLayer.style.display = 'block';
    if (freezeImg.complete) ready();
  };
  const startFreeze = () => {
    if (!enabled || phase === 'freezing' || phase === 'annotating') return;
    phase = 'freezing';
    hide();
    sizeCanvas();
    freezeLayer.style.visibility = '';
    freezeLayer.style.display = 'block';
    freezeLayer.style.background = 'transparent';
    freezeImg.style.opacity = '1';
    draw.style.opacity = '1';
    cropCard.style.display = 'none';
    send({ type: 'freeze-request' });
  };
  const appendStroke = (event) => {
    if (!currentStroke) return;
    currentStroke.push({ x: event.clientX, y: event.clientY });
    paintStrokes();
  };
  const onHover = (event) => {
    if (!enabled || phase !== 'idle') return;
    hoverEl = meaningful(event.target);
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        paint(hoverEl);
      });
    }
  };
  const block = (event) => {
    if (!enabled) return;
    if (inChrome(event.target) || freezeLayer.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const pickFrom = (target) => {
    if (!enabled || picking || phase === 'annotating' || phase === 'freezing') return;
    const el = meaningful(target) || hoverEl;
    if (!el) return;
    picking = true;
    send({ type: 'picked', payload: payload(el) });
  };
  const onClick = (event) => {
    if (!enabled) return;
    if (inChrome(event.target) || freezeLayer.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (phase !== 'idle') return;
    pickFrom(event.target);
  };
  const finishStroke = () => {
    currentStroke = null;
    if (flatten().length < 2) {
      if (phase === 'pending') {
        phase = 'idle';
        strokes = [];
        return false;
      }
      if (cropCard.style.display !== 'block') exitAnnotation();
      return false;
    }
    if (phase === 'freezing') {
      pendingCommit = true;
      return true;
    }
    if (phase === 'annotating') {
      showActions();
      return true;
    }
    return false;
  };
  const onPointerDown = (event) => {
    if (!enabled || event.button !== 0) return;
    if (actions.contains(event.target)) return;
    if (cropCard.contains(event.target) && cropCard.style.display === 'block') {
      event.preventDefault();
      event.stopPropagation();
      const handle = event.target && event.target.dataset ? event.target.dataset.handle : '';
      cropDrag = {
        handle: handle || 'move',
        x: event.clientX,
        y: event.clientY,
        box: cropRect(),
      };
      return;
    }
    if (inChrome(event.target)) return;
    if (freezeLayer.contains(event.target) && phase === 'annotating') {
      event.preventDefault();
      event.stopPropagation();
      currentStroke = [{ x: event.clientX, y: event.clientY }];
      strokes.push(currentStroke);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (phase !== 'idle') return;
    try { event.target.setPointerCapture(event.pointerId); } catch {}
    phase = 'pending';
    pressAt = Date.now();
    pressX = event.clientX;
    pressY = event.clientY;
    pressHover = meaningful(event.target) || hoverEl;
    currentStroke = [{ x: event.clientX, y: event.clientY }];
    strokes = [currentStroke];
    holdTimer = setTimeout(() => {
      holdTimer = 0;
    }, HOLD_MS);
  };
  const onPointerMove = (event) => {
    if (!enabled) return;
    if (cropDrag) {
      event.preventDefault();
      event.stopPropagation();
      applyCropDrag(event);
      return;
    }
    if (phase === 'idle') {
      onHover(event);
      return;
    }
    if (!currentStroke) return;
    event.preventDefault();
    event.stopPropagation();
    appendStroke(event);
    if (phase !== 'pending') return;
    const dx = event.clientX - pressX;
    const dy = event.clientY - pressY;
    if (Math.sqrt(dx * dx + dy * dy) > MOVE_PX) {
      clearTimeout(holdTimer);
      holdTimer = 0;
      startFreeze();
    }
  };
  const onPointerUp = (event) => {
    if (!enabled || event.button !== 0) return;
    if (cropDrag) {
      event.preventDefault();
      event.stopPropagation();
      applyCropDrag(event);
      cropDrag = null;
      return;
    }
    if (inChrome(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (phase === 'freezing' || phase === 'annotating') {
      finishStroke();
      return;
    }
    if (phase === 'pending') {
      clearTimeout(holdTimer);
      holdTimer = 0;
      phase = 'idle';
      strokes = [];
      currentStroke = null;
      pickFrom(event.target);
    }
  };
  const onKey = (event) => {
    if (!enabled || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (phase === 'annotating' || phase === 'freezing' || phase === 'pending') {
      clearTimeout(holdTimer);
      holdTimer = 0;
      pendingCommit = false;
      exitAnnotation();
      return;
    }
    send({ type: 'cancelled' });
  };
  const onAdd = (event) => {
    event.preventDefault();
    event.stopPropagation();
    commitAnnotation();
  };
  const onCancel = (event) => {
    event.preventDefault();
    event.stopPropagation();
    exitAnnotation();
  };
  addBtn.addEventListener('pointerup', onAdd);
  addBtn.addEventListener('click', onAdd);
  cancelBtn.addEventListener('pointerup', onCancel);
  cancelBtn.addEventListener('click', onCancel);
  const setEnabled = (on) => {
    enabled = on;
    picking = false;
    clearTimeout(holdTimer);
    holdTimer = 0;
    if (on) {
      mount();
      showChrome();
      document.addEventListener('mousemove', onHover, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('pointerup', onPointerUp, true);
      document.addEventListener('pointercancel', onPointerUp, true);
      document.addEventListener('mousedown', block, true);
      document.addEventListener('keydown', onKey, true);
      return;
    }
    document.removeEventListener('mousemove', onHover, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('pointercancel', onPointerUp, true);
    document.removeEventListener('mousedown', block, true);
    document.removeEventListener('keydown', onKey, true);
    hoverEl = null;
    exitAnnotation();
    if (root.isConnected) root.remove();
  };
  window.__ensoDesignMode = { setEnabled, hide, showChrome, showFrozen, composeImage };
  setEnabled(true);
  return 'on';
})()`;

export const PAGE_DESIGN_MODE_DISABLE_SCRIPT = `(() => {
  window.__ensoDesignMode?.setEnabled(false);
  return 'off';
})()`;

export const PAGE_DESIGN_MODE_HIDE_SCRIPT = `(() => {
  window.__ensoDesignMode?.hide();
  return 'ok';
})()`;

export const pageDesignModeShowFrozenScript = (dataUrl: string): string => `(() => {
  window.__ensoDesignMode?.showFrozen(${JSON.stringify(dataUrl)});
  return 'ok';
})()`;

export const PAGE_DESIGN_MODE_COMPOSE_SCRIPT = `(() => {
  window.__ensoDesignMode?.hide();
  return window.__ensoDesignMode?.composeImage?.() || '';
})()`;

const DESIGN_CSS_PROPERTY_NAMES = DESIGN_CSS_PROPERTIES.map(({ name }) => name);

/**
 * 主世界（Main World）组件栈探测器：读取 React Fiber / Vue ParentComponent / Svelte Meta。
 * 1:1 复刻 Cursor `installComponentProbe`。
 */
export const PAGE_COMPONENT_PROBE_SCRIPT = `(() => {
  const QUERY = 'molten-picker-component-query';
  const RESULT = 'molten-picker-component-result';
  const KEY = '__moltenPickerComponentProbe';
  const MAX_DEPTH = 5;
  const NON_COMPONENT_PREFIXES = ['_', '$', 'Primitive.', 'Slot.'];
  const INTERNAL = new Set([
    'Suspense',
    'Fragment',
    'StrictMode',
    'Profiler',
    'SuspenseList',
    'InnerLayoutRouter',
    'RedirectErrorBoundary',
    'RedirectBoundary',
    'HTTPAccessFallbackErrorBoundary',
    'HTTPAccessFallbackBoundary',
    'LoadingBoundary',
    'ErrorBoundary',
    'InnerScrollAndFocusHandler',
    'ScrollAndFocusHandler',
    'RenderFromTemplateContext',
    'OuterLayoutRouter',
    'DevRootHTTPAccessFallbackBoundary',
    'AppDevOverlayErrorBoundary',
    'AppDevOverlay',
    'HotReload',
    'Router',
    'ErrorBoundaryHandler',
    'AppRouter',
    'ServerRoot',
    'SegmentStateProvider',
    'RootErrorBoundary',
    'LoadableComponent',
    'MotionDOMComponent',
    'SlotClone',
  ]);
  const isUserComponent = (name) =>
    name.length > 1 &&
    name[0] === name[0]?.toUpperCase() &&
    !INTERNAL.has(name) &&
    !name.endsWith('Provider') &&
    !name.endsWith('Context') &&
    !NON_COMPONENT_PREFIXES.some((prefix) => name.startsWith(prefix));
  const nameOf = (value) => {
    if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) return null;
    const name =
      ('displayName' in value ? value.displayName : undefined) ??
      ('name' in value ? value.name : undefined);
    return typeof name === 'string' && name.length > 0 ? name : null;
  };
  const fiberName = (fiber) => {
    const type = fiber.elementType ?? fiber.type;
    if (typeof type === 'function') return nameOf(type);
    if (typeof type !== 'object' || type === null || !('$$typeof' in type)) return null;
    const render = 'render' in type ? type.render : undefined;
    if (render !== undefined) return nameOf(render);
    const inner = 'type' in type ? type.type : undefined;
    return typeof inner === 'function' ? nameOf(inner) : null;
  };
  const reactStack = (element) => {
    const stack = [];
    const key = Object.keys(element).find(
      (name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$')
    );
    const found = key === undefined ? null : Object.getOwnPropertyDescriptor(element, key)?.value;
    let fiber = typeof found === 'object' ? found : null;
    while (fiber != null && stack.length < MAX_DEPTH) {
      const name = fiberName(fiber);
      if (name !== null && isUserComponent(name)) stack.push(name);
      fiber = fiber.return ?? null;
    }
    return stack;
  };
  const vueTypeName = (type) => {
    if (typeof type === 'function') return type.name;
    if (typeof type !== 'object' || type === null) return undefined;
    return ('__name' in type ? type.__name : undefined) ?? ('name' in type ? type.name : undefined);
  };
  const vueStack = (element) => {
    const stack = [];
    for (let node = element; node !== null; node = node.parentElement) {
      let component = '__vueParentComponent' in node ? node.__vueParentComponent : undefined;
      if (typeof component !== 'object' || component === null) continue;
      while (typeof component === 'object' && component !== null && stack.length < MAX_DEPTH) {
        const name = vueTypeName('type' in component ? component.type : undefined);
        if (typeof name === 'string' && name.length > 0) stack.push(name);
        component = 'parent' in component ? component.parent : undefined;
      }
      break;
    }
    return stack;
  };
  const svelteStack = (element) => {
    const stack = [];
    for (let node = element; node !== null; node = node.parentElement) {
      const meta = '__svelte_meta' in node ? node.__svelte_meta : undefined;
      if (typeof meta !== 'object' || meta === null) continue;
      let parent = 'parent' in meta ? meta.parent : undefined;
      while (typeof parent === 'object' && parent !== null && stack.length < MAX_DEPTH) {
        const tag = 'componentTag' in parent ? parent.componentTag : undefined;
        if (typeof tag === 'string') stack.push(tag);
        parent = 'parent' in parent ? parent.parent : undefined;
      }
      break;
    }
    return stack;
  };
  const detect = (element) => {
    try {
      const react = reactStack(element);
      if (react.length > 0) return { framework: 'react', stack: react };
      const vue = vueStack(element);
      if (vue.length > 0) return { framework: 'vue', stack: vue };
      const svelte = svelteStack(element);
      if (svelte.length > 0) return { framework: 'svelte', stack: svelte };
    } catch {}
    return null;
  };
  const previous = KEY in window ? window[KEY] : undefined;
  if (previous instanceof AbortController) previous.abort();
  const controller = new AbortController();
  Object.defineProperty(window, KEY, { value: controller, configurable: true });
  window.addEventListener(
    QUERY,
    (event) => {
      event.stopImmediatePropagation();
      const target = event.composedPath()[0];
      const info = target instanceof Element ? detect(target) : null;
      window.dispatchEvent(new CustomEvent(RESULT, { detail: JSON.stringify(info) }));
    },
    { capture: true, signal: controller.signal }
  );
  return true;
})()`;

/**
 * 完整 Cursor Guest Design Runtime：
 * - 闭合 Shadow DOM `<molten-glass-overlay>`
 * - 8 色悬停与选中框 + 自适应身份胶囊 (`Component · tag` / `tag#id` / `tag.class`)
 * - 单击、Shift 多选（松开 Shift 提交）、Alt 换色直发 Chat、ArrowUp/ArrowDown DOM 游走
 * - Marquee 选区（Shift 锁轴、Alt 中心、Space 平移、Escape 取消）
 * - MutationObserver 节点重绑与 Pin 跟随
 * - 页面内编号 Pin 徽章、悬停评论卡片、4 边离屏胶囊（平滑滚动到最近 Pin）
 * - 页内 CSS 读取与 `queue`/`draft` 双层实时样式预览
 */
export const PAGE_DESIGN_RUNTIME_SCRIPT = `(() => {
  if (window.__ensoDesignRuntime) return window.__ensoDesignRuntime;
  const BINDING = ${JSON.stringify(DESIGN_MODE_BINDING)};
  const sendBinding = (payload) => {
    try {
      const fn = window[BINDING];
      if (typeof fn === 'function') fn(JSON.stringify(payload));
    } catch {}
  };

  const pinGeometry = () => {
    const BADGE_SIZE = 22;
    const BADGE_GAP = 4;
    const GUTTER_INSET = 8;
    const PILL_INSET = 8;
    const PILL_HEIGHT = 20;
    const PILL_MIN_WIDTH = 40;
    const PILL_DIGIT_WIDTH = 7;
    const PILL_BADGE_GAP = 4;
    const placePinBadge = (rect, viewportWidth, inset) => {
      const top = rect.top >= 0 && rect.top < inset ? inset : rect.top;
      const rightLeft = rect.left + rect.width + BADGE_GAP;
      if (rightLeft + BADGE_SIZE <= viewportWidth - BADGE_GAP)
        return { top, left: rightLeft, corner: 'top-left' };
      return {
        top,
        left: Math.max(inset + BADGE_GAP, rect.left - BADGE_GAP - BADGE_SIZE),
        corner: 'top-right',
      };
    };
    const placeDetachedPinBadge = (index, viewportWidth, inset) => ({
      top: Math.max(GUTTER_INSET, inset + BADGE_GAP) + index * (BADGE_SIZE + BADGE_GAP),
      left: viewportWidth - BADGE_SIZE - GUTTER_INSET,
      corner: 'top-right',
    });
    const badgeBox = (placement) => ({
      top: placement.top,
      left: placement.left,
      width: BADGE_SIZE,
      height: BADGE_SIZE,
    });
    const offscreenEdge = (rect, width, height) => {
      if (rect.top + rect.height <= 0) return 'top';
      if (rect.top >= height) return 'bottom';
      if (rect.left + rect.width <= 0) return 'left';
      if (rect.left >= width) return 'right';
      if (rect.top < 0) return 'top';
      if (rect.top + rect.height > height) return 'bottom';
      if (rect.left < 0) return 'left';
      if (rect.left + rect.width > width) return 'right';
      return null;
    };
    const edgeDistance = (rect, edge, width, height) => {
      if (edge === 'top') return -(rect.top + rect.height);
      if (edge === 'bottom') return rect.top - height;
      if (edge === 'left') return -(rect.left + rect.width);
      return rect.left - width;
    };
    const clampPill = (value, min, max) =>
      min > max ? (min + max) / 2 : Math.min(Math.max(value, min), max);
    const clearOfBadges = (center, half, min, max, rowTop, drawn) => {
      const inRow = drawn.filter(
        (badge) =>
          badge.top < rowTop + PILL_HEIGHT + PILL_BADGE_GAP &&
          badge.top + badge.height > rowTop - PILL_BADGE_GAP
      );
      const reach = half + PILL_BADGE_GAP;
      const covers = (at) =>
        inRow.some((badge) => at - reach < badge.left + badge.width && at + reach > badge.left);
      const clear = [
        center,
        ...inRow.flatMap((badge) => [badge.left - reach, badge.left + badge.width + reach]),
      ]
        .filter((at) => at >= min && at <= max && !covers(at))
        .sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
      return clear[0] ?? center;
    };
    const pillCenter = (rect, edge, count, drawn, width, height) => {
      if (edge === 'top' || edge === 'bottom') {
        const digits = Math.max(0, String(Math.max(1, count)).length - 1);
        const half = (PILL_MIN_WIDTH + digits * PILL_DIGIT_WIDTH) / 2;
        const min = PILL_INSET + half;
        const max = width - PILL_INSET - half;
        return clearOfBadges(
          clampPill(rect.left + rect.width / 2, min, max),
          half,
          min,
          max,
          edge === 'top' ? PILL_INSET : height - PILL_INSET - PILL_HEIGHT,
          drawn
        );
      }
      const half = PILL_HEIGHT / 2;
      const corner = PILL_INSET + PILL_HEIGHT;
      return clampPill(
        rect.top + rect.height / 2,
        corner + PILL_INSET + half,
        height - corner - PILL_INSET - half
      );
    };
    return {
      BADGE_SIZE,
      BADGE_GAP,
      PILL_INSET,
      PILL_HEIGHT,
      PILL_MIN_WIDTH,
      placePinBadge,
      placeDetachedPinBadge,
      badgeBox,
      offscreenEdge,
      edgeDistance,
      clampPill,
      clearOfBadges,
      pillCenter,
    };
  };

  const installPagePins = (ctx, geometry) => {
    const {
      BADGE_SIZE,
      BADGE_GAP,
      PILL_INSET,
      PILL_HEIGHT,
      PILL_MIN_WIDTH,
      placePinBadge,
      placeDetachedPinBadge,
      badgeBox,
      offscreenEdge,
      edgeDistance,
      pillCenter,
    } = geometry;
    const ACCENT = '58,150,221';
    const CARD_WIDTH = 240;
    const CARD_OFFSET = 8;
    const PILL_EDGES = ['top', 'bottom', 'left', 'right'];
    const PILL_WORDS = {
      top: 'above',
      bottom: 'below',
      left: 'to the left',
      right: 'to the right',
    };
    const PILL_ROTATION = { bottom: 0, left: 90, top: 180, right: 270 };
    const PILL_TRANSFORM = {
      top: 'translate(-50%, 0)',
      bottom: 'translate(-50%, -100%)',
      left: 'translate(0, -50%)',
      right: 'translate(-100%, -50%)',
    };
    const PINS_CSS = \`
      .box { position: fixed; box-sizing: border-box; border: 1px solid rgba(\${ACCENT},0.45); border-radius: 2px;
        background: rgba(\${ACCENT},0.08); opacity: 0.7; pointer-events: none; animation: box-in 120ms ease-out; }
      .box.region { border-style: dashed; border-color: rgb(\${ACCENT}); }
      @keyframes box-in { from { opacity: 0; } to { opacity: 0.7; } }
      .badge, .pill { all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
        background: rgb(\${ACCENT}); color: #fff; font-family: system-ui, sans-serif; font-weight: 600; line-height: 1;
        font-variant-numeric: tabular-nums; box-shadow: 0 0 0 2px #fff, 0 1px 2px rgba(0,0,0,0.22); cursor: pointer;
        pointer-events: auto; user-select: none; }
      .badge { position: fixed; width: \${BADGE_SIZE}px; height: \${BADGE_SIZE}px; border-radius: 11px 11px 11px 2px;
        font-size: 12px; }
      .badge:active, .pill:active { transform: scale(0.95); }
      .badge.detached { opacity: 0.55; }
      .card { position: fixed; box-sizing: border-box; width: \${CARD_WIDTH}px; display: none; flex-direction: column;
        gap: 2px; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.1); background: #fff;
        color: #242424; box-shadow: 0 8px 24px -6px rgba(0,0,0,0.1); font: 400 13px/18px system-ui, sans-serif;
        overflow-wrap: anywhere; pointer-events: none; }
      .card .meta { color: rgba(0,0,0,0.5); font-size: 11px; line-height: 16px; }
      .card .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pill-anchor { position: fixed; display: flex; pointer-events: none; }
      .pill { gap: 2px; height: \${PILL_HEIGHT}px; min-width: \${PILL_MIN_WIDTH}px; padding: 0 6px 0 4px;
        border-radius: 999px; font-size: 11px; animation: pill-in 120ms ease-out; transition: transform 120ms ease-out; }
      @keyframes pill-in { from { opacity: 0; transform: scale(0.9); } }
      @media (prefers-reduced-motion: reduce) { .box, .pill { animation: none; } }
    \`;
    let notes = { specs: [], bound: new Map() };
    const lastSeen = new Map();
    const badgeUids = new Map();
    let view = null;
    const rectOf = (element) => {
      if (element === null || !element.isConnected) return null;
      const box = element.getBoundingClientRect();
      return box.width === 0 && box.height === 0
        ? null
        : { top: box.top, left: box.left, width: box.width, height: box.height };
    };
    const fingerprintMatches = (element, wanted) =>
      element.id === wanted.id &&
      ctx.classNameOf(element) === wanted.className &&
      ctx.elementText(element).slice(0, 200) === wanted.innerText;
    const resolve = () => {
      let moved = false;
      const held = new Set();
      for (const elements of notes.bound.values())
        for (const element of elements) if (element?.isConnected === true) held.add(element);
      const bound = new Map();
      for (const spec of notes.specs) {
        const was = notes.bound.get(spec.id) ?? [];
        const next = spec.elements.map((wanted, index) => {
          const kept = was[index];
          if (kept?.isConnected === true) return kept;
          if (wanted.tagName === 'HTML') return document.documentElement;
          const named = ctx.elementOf(wanted.uid);
          if (named?.isConnected === true) {
            held.add(named);
            return named;
          }
          if (wanted.tagName.length === 0) return null;
          const candidate = Array.from(document.getElementsByTagName(wanted.tagName)).find(
            (element) => !held.has(element) && fingerprintMatches(element, wanted)
          );
          if (candidate === undefined) return null;
          held.add(candidate);
          if (wanted.uid.length > 0) ctx.adopt(candidate, wanted.uid);
          return candidate;
        });
        moved ||= next.some((element, index) => element !== null && element !== was[index]);
        bound.set(spec.id, next);
      }
      notes = { specs: notes.specs, bound };
      return moved;
    };
    const pageScrollerOf = (element) => {
      for (
        let node = element;
        node !== null && node !== document.documentElement;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        if (style.position === 'fixed') return null;
        if (
          node !== element &&
          /(auto|scroll|overlay)/.test(style.overflowX + style.overflowY) &&
          (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)
        ) {
          if (node !== document.body) return null;
          const root = getComputedStyle(document.documentElement);
          return root.overflowX === 'visible' && root.overflowY === 'visible' ? window : node;
        }
      }
      return window;
    };
    const scrollIntoView = (id, behavior) => {
      const spec = notes.specs.find((candidate) => candidate.id === id);
      const element = (notes.bound.get(id) ?? []).find((bound) => bound?.isConnected === true);
      if (spec === undefined || element == null) return;
      const rect = element.getBoundingClientRect();
      const target =
        spec.region ??
        (rect.height > innerHeight
          ? { top: 0, left: 0, width: rect.width, height: BADGE_SIZE }
          : null);
      const scroller = target === null ? null : pageScrollerOf(element);
      if (target !== null && scroller !== null) {
        scroller.scrollBy({
          top: rect.top + target.top + target.height / 2 - innerHeight / 2,
          left: rect.left + target.left + target.width / 2 - innerWidth / 2,
          behavior,
        });
      } else {
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior });
      }
      layout();
    };
    const chevron = (edge) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '12');
      svg.setAttribute('height', '12');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText = \`transform: rotate(\${PILL_ROTATION[edge]}deg); flex-shrink: 0;\`;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M4.5 6.5 8 10l3.5-3.5');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.6');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.append(path);
      return svg;
    };
    const stopPress = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const makeBadge = (id) => {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'badge';
      badge.addEventListener('pointerdown', stopPress);
      badge.addEventListener('click', (event) => {
        stopPress(event);
        ctx.push({ type: 'pin-click', id });
      });
      badge.addEventListener('pointerenter', () => {
        if (view === null) return;
        ctx.clearHover();
        view.hovered = id;
        layout();
      });
      badge.addEventListener('pointerleave', () => {
        if (view === null || view.hovered !== id) return;
        view.hovered = null;
        layout();
      });
      return badge;
    };
    const makePill = (edge) => {
      const anchor = document.createElement('div');
      anchor.className = 'pill-anchor';
      anchor.style.transform = PILL_TRANSFORM[edge];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pill';
      button.dataset.edge = edge;
      const count = document.createElement('span');
      button.append(chevron(edge), count);
      anchor.append(button);
      const pill = { anchor, button, count, nearest: '' };
      button.addEventListener('pointerdown', stopPress);
      button.addEventListener('click', (event) => {
        stopPress(event);
        scrollIntoView(pill.nearest, 'smooth');
      });
      return pill;
    };
    const renderCard = (pin, width, height) => {
      if (view === null) return;
      const card = view.card;
      if (pin === undefined || view.open !== null) {
        card.style.display = 'none';
        return;
      }
      const comment = document.createElement('div');
      comment.textContent = pin.spec.comment;
      const label = document.createElement('div');
      label.className = 'meta label';
      label.textContent = pin.spec.label;
      card.replaceChildren(comment, label);
      if (pin.detached) {
        const hidden = document.createElement('div');
        hidden.className = 'meta';
        hidden.textContent = 'Not visible at this width';
        card.append(hidden);
      }
      card.style.display = 'flex';
      const { top, left, corner } = pin.placement;
      const right = left + BADGE_SIZE + CARD_OFFSET;
      const before = left - CARD_OFFSET - CARD_WIDTH;
      const fitsRight = right + CARD_WIDTH <= width - BADGE_GAP;
      const fitsLeft = before >= BADGE_GAP;
      const x = (corner === 'top-left' && fitsRight) || !fitsLeft ? right : before;
      card.style.left = \`\${Math.max(BADGE_GAP, Math.min(x, width - CARD_WIDTH - BADGE_GAP))}px\`;
      card.style.top = \`\${Math.max(BADGE_GAP, Math.min(top, height - card.offsetHeight - BADGE_GAP))}px\`;
    };
    const layout = () => {
      if (view === null) return;
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      const inset = ctx.rulerInset();
      const toRegion = (spec, rect) =>
        rect === null || spec.region === null
          ? rect
          : {
              top: rect.top + spec.region.top,
              left: rect.left + spec.region.left,
              width: spec.region.width,
              height: spec.region.height,
            };
      const measured = notes.specs.map((spec) => {
        const raw = (notes.bound.get(spec.id) ?? []).map(rectOf);
        raw.forEach((rect, index) => {
          const uid = spec.elements[index]?.uid;
          if (rect !== null && uid !== undefined && uid.length > 0)
            lastSeen.set(uid, { ...rect, top: rect.top + scrollY, left: rect.left + scrollX });
        });
        const onScreen = spec.elements[raw.findIndex((rect) => rect !== null)];
        if (onScreen !== undefined && onScreen.uid.length > 0) badgeUids.set(spec.id, onScreen.uid);
        const badgeUid = badgeUids.get(spec.id);
        const seen =
          spec.elements.find((element) => element.uid === badgeUid && lastSeen.has(element.uid)) ??
          spec.elements.find((element) => lastSeen.has(element.uid));
        const last = seen === undefined ? undefined : lastSeen.get(seen.uid);
        const lastKnown =
          last === undefined ? null : { ...last, top: last.top - scrollY, left: last.left - scrollX };
        const rects =
          spec.region === null ? raw : raw.slice(0, 1).map((rect) => toRegion(spec, rect));
        const primary = rects.find((rect) => rect !== null) ?? null;
        return {
          spec,
          rects,
          badgeRect: primary ?? toRegion(spec, lastKnown),
          detached: primary === null,
        };
      });
      const detachedNumbers = measured
        .filter((pin) => pin.badgeRect !== null && pin.detached)
        .map((pin) => pin.spec.number)
        .sort((a, b) => a - b);
      const placed = measured.flatMap(({ spec, rects, badgeRect, detached }) => {
        if (badgeRect === null) return [];
        const placement = detached
          ? placeDetachedPinBadge(detachedNumbers.indexOf(spec.number), width, inset)
          : placePinBadge(badgeRect, width, inset);
        return [{ spec, rects, detached, placement }];
      });
      view.placed = placed;
      const drawn = placed.filter(
        (pin) => pin.detached || offscreenEdge(badgeBox(pin.placement), width, height) === null
      );
      if (view.hovered !== null && !drawn.some((pin) => pin.spec.id === view?.hovered))
        view.hovered = null;
      const badges = view.badges;
      for (const [id, badge] of badges) {
        if (drawn.some((pin) => pin.spec.id === id)) continue;
        badge.remove();
        badges.delete(id);
      }
      for (const { spec, detached, placement } of drawn) {
        let badge = badges.get(spec.id);
        if (badge === undefined) {
          badge = makeBadge(spec.id);
          badges.set(spec.id, badge);
          view.root.append(badge);
        }
        badge.textContent = String(spec.number);
        badge.setAttribute('aria-label', \`Annotation \${spec.number}: \${spec.comment}\`);
        badge.dataset.number = String(spec.number);
        badge.classList.toggle('detached', detached);
        badge.style.left = \`\${placement.left}px\`;
        badge.style.top = \`\${placement.top}px\`;
      }
      const focused = placed.filter(
        (pin) => pin.spec.id === view?.hovered || pin.spec.id === view?.open
      );
      const boxRects = focused.flatMap((pin) =>
        pin.rects.flatMap((rect) =>
          rect === null ? [] : [{ rect, region: pin.spec.region !== null }]
        )
      );
      const boxKey = \`\${focused.map((pin) => pin.spec.id).join(' ')}:\${boxRects.length}\`;
      if (boxKey !== view.boxKey) {
        view.boxKey = boxKey;
        view.boxes.replaceChildren(
          ...boxRects.map(({ region }) => {
            const box = document.createElement('div');
            box.className = region ? 'box region' : 'box';
            return box;
          })
        );
      }
      boxRects.forEach(({ rect }, index) => {
        const box = view?.boxes.children[index];
        if (box instanceof HTMLElement)
          ctx.placeBox(box, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
      });
      renderCard(
        drawn.find((pin) => pin.spec.id === view?.hovered),
        width,
        height
      );
      const offscreen = placed.filter((pin) => !pin.detached);
      const drawnBoxes = drawn.map((pin) => badgeBox(pin.placement));
      for (const edge of PILL_EDGES) {
        const onEdge = offscreen
          .map((pin) => ({ pin, rect: badgeBox(pin.placement) }))
          .filter(({ rect }) => offscreenEdge(rect, width, height) === edge)
          .map((entry) => ({
            ...entry,
            distance: edgeDistance(entry.rect, edge, width, height),
          }))
          .sort((a, b) => a.distance - b.distance || a.pin.spec.number - b.pin.spec.number);
        const nearest = onEdge[0];
        const existing = view.pills.get(edge);
        if (nearest === undefined) {
          existing?.anchor.remove();
          view.pills.delete(edge);
          continue;
        }
        const pill = existing ?? makePill(edge);
        if (existing === undefined) {
          view.pills.set(edge, pill);
          view.root.append(pill.anchor);
        }
        const count = onEdge.length;
        const label = \`\${count} \${count === 1 ? 'annotation' : 'annotations'} \${PILL_WORDS[edge]}, scroll to nearest\`;
        pill.nearest = nearest.pin.spec.id;
        pill.count.textContent = String(count);
        pill.button.setAttribute('aria-label', label);
        pill.button.title = label;
        const center = pillCenter(nearest.rect, edge, count, drawnBoxes, width, height);
        let top = center;
        let left = center;
        if (edge === 'top') top = PILL_INSET;
        else if (edge === 'bottom') top = height - PILL_INSET;
        else if (edge === 'left') left = PILL_INSET;
        else left = width - PILL_INSET;
        pill.anchor.style.top = \`\${top}px\`;
        pill.anchor.style.left = \`\${left}px\`;
      }
      const pinned = offscreen.map((pin) => pin.spec.id);
      const pinnedKey = pinned.join(' ');
      if (pinnedKey !== view.pinnedKey) {
        view.pinnedKey = pinnedKey;
        ctx.push({ type: 'pins', ids: pinned });
      }
    };
    const mount = () => {
      if (view !== null) return;
      const { host, root } = ctx.makeHost(PINS_CSS);
      const boxes = document.createElement('div');
      const card = document.createElement('div');
      card.className = 'card';
      card.setAttribute('aria-hidden', 'true');
      root.append(boxes, card);
      window.addEventListener('resize', layout);
      view = {
        host,
        root,
        boxes,
        card,
        badges: new Map(),
        pills: new Map(),
        placed: [],
        hovered: null,
        open: null,
        boxKey: '',
        pinnedKey: '',
        queued: false,
      };
    };
    const unmount = (report) => {
      if (view === null) return;
      const hadPinned = view.pinnedKey.length > 0;
      window.removeEventListener('resize', layout);
      view.host.remove();
      view = null;
      if (report && hadPinned) ctx.push({ type: 'pins', ids: [] });
    };
    return {
      layout,
      start: () => {
        if (notes.specs.length === 0) return;
        mount();
        layout();
      },
      stop: () => {
        unmount(false);
        notes = { specs: [], bound: new Map() };
      },
      host: () => view?.host,
      opened: () => view !== null && view.open !== null,
      noteMutations: (records) => {
        if (view === null || view.queued) return;
        if (
          records.every((record) =>
            [...record.addedNodes, ...record.removedNodes].every(
              (n) => n.nodeName === ctx.overlayTag
            )
          )
        )
          return;
        view.queued = true;
        void ctx.nextFrame().then(() => {
          if (view === null) return;
          view.queued = false;
          if (resolve()) ctx.restyle();
          layout();
        });
      },
      set: (specs) => {
        const ids = new Set(specs.map((spec) => spec.id));
        notes = {
          specs,
          bound: new Map([...notes.bound].filter(([id]) => ids.has(id))),
        };
        if (!ctx.designOn()) return false;
        if (resolve()) ctx.restyle();
        if (specs.length === 0) {
          unmount(true);
          return true;
        }
        mount();
        if (view !== null && view.open !== null && !ids.has(view.open)) view.open = null;
        layout();
        return true;
      },
      open: async (id, reveal) => {
        if (view === null) return null;
        if (id === null) {
          view.open = null;
          layout();
          return null;
        }
        if (reveal) scrollIntoView(id, 'instant');
        if (!view.placed.some((pin) => pin.spec.id === id)) return null;
        view.open = id;
        view.hovered = null;
        layout();
        await ctx.nextFrame();
        await ctx.nextFrame();
        const pin = view?.placed.find((candidate) => candidate.spec.id === id);
        if (view === null || pin === undefined || view.open !== id) return null;
        return {
          top: pin.placement.top,
          left: pin.placement.left,
          detached: pin.detached,
          rulerInset: ctx.rulerInset(),
          viewportWidth: innerWidth,
        };
      },
    };
  };

  const installCss = (trackedSelectionEntries) => {
    const CSS_PROPERTIES = ${JSON.stringify(DESIGN_CSS_PROPERTY_NAMES)};
    const CSS_TARGET_ATTRIBUTE = ${JSON.stringify(DESIGN_CSS_TARGET_ATTRIBUTE)};
    const CSS_TEXT_TAGS = new Set(['P', 'SPAN', 'A', 'BUTTON', 'LABEL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'EM', 'B', 'I', 'SMALL', 'BLOCKQUOTE', 'FIGCAPTION', 'TD', 'TH', 'SUMMARY', 'CODE', 'PRE']);
    const CSS_LOGICAL = {
      padding: ['padding-inline', 'padding-block'],
      margin: ['margin-inline', 'margin-block'],
      inset: ['inset-inline', 'inset-block'],
      'border-width': ['border-inline-width', 'border-block-width'],
      'border-radius': ['border-start-start-radius', 'border-start-end-radius', 'border-end-start-radius', 'border-end-end-radius'],
      width: ['inline-size'],
      height: ['block-size'],
    };
    const CSS_REPLACED_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG', 'IFRAME', 'INPUT', 'SELECT', 'TEXTAREA', 'OBJECT', 'EMBED']);
    const trackedElementForUid = (uid) => {
      const entry = trackedSelectionEntries().find((e) => e.uid === uid);
      return entry && entry.el.isConnected ? entry.el : null;
    };
    const slots = { queue: {}, draft: {} };
    const pageValues = new Map();
    const unstyled = new WeakSet();
    const renderPreview = () => {
      const wanted = new Map();
      for (const spec of [slots.queue, slots.draft]) {
        for (const [uid, edits] of Object.entries(spec)) {
          const el = trackedElementForUid(uid);
          if (el) wanted.set(el, Object.assign(wanted.get(el) ?? {}, edits));
        }
      }
      for (const [el, saved] of pageValues) {
        const edits = wanted.get(el) ?? {};
        for (const [property, value] of saved) {
          if (property in edits) continue;
          if (value === '') el.style.removeProperty(property);
          else el.style.setProperty(property, value);
          saved.delete(property);
        }
        if (saved.size > 0) continue;
        pageValues.delete(el);
        if (unstyled.has(el) && el.style.length === 0) el.removeAttribute('style');
      }
      for (const [el, edits] of wanted) {
        const saved = pageValues.get(el) ?? new Map();
        if (!pageValues.has(el) && !el.hasAttribute('style')) unstyled.add(el);
        pageValues.set(el, saved);
        for (const [property, value] of Object.entries(edits)) {
          if (!saved.has(property)) saved.set(property, el.style.getPropertyValue(property));
          if (value !== null) el.style.setProperty(property, value);
          else if (saved.get(property) !== '') el.style.removeProperty(property);
          else el.style.setProperty(property, 'revert');
        }
      }
    };
    const previewCss = (slot, spec) => {
      slots[slot] = spec;
      renderPreview();
      const uid = Object.keys(spec)[0];
      const r = (uid ? trackedElementForUid(uid) : null)?.getBoundingClientRect();
      return r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
    };
    let cssMarked = null;
    const markCss = (uid, token) => {
      const el = trackedElementForUid(uid);
      if (!el) return false;
      el.setAttribute(CSS_TARGET_ATTRIBUTE, token);
      cssMarked = el;
      return true;
    };
    const unmarkCss = (token) => {
      if (cssMarked?.getAttribute(CSS_TARGET_ATTRIBUTE) !== token) return;
      cssMarked.removeAttribute(CSS_TARGET_ATTRIBUTE);
      cssMarked = null;
    };
    const cssDeclared = (blocks) => {
      const names = new Set();
      const declared = {};
      const important = new Set();
      const expand = (properties) => {
        const scratch = document.createElement('div').style;
        for (const name of properties) scratch.setProperty(name, 'initial');
        return Array.from(scratch);
      };
      const physical = new Map(CSS_PROPERTIES.map((property) => [property, expand([property])]));
      const logical = new Map(
        CSS_PROPERTIES.map((property) => [property, expand(CSS_LOGICAL[property] ?? [])])
      );
      const take = (style) => {
        const set = Array.from(style);
        for (const property of CSS_PROPERTIES) {
          const value = style.getPropertyValue(property);
          const isImportant = style.getPropertyPriority(property) === 'important';
          const overriding = set.filter(
            (name) =>
              logical.get(property).includes(name) ||
              (!value && physical.get(property).includes(name))
          );
          const overridingImportant = overriding.some(
            (name) => style.getPropertyPriority(name) === 'important'
          );
          if (overriding.length > 0 && (overridingImportant || !isImportant)) {
            if (important.has(property) && !overridingImportant) continue;
            delete declared[property];
            if (overridingImportant) important.add(property);
            continue;
          }
          if (!value || (important.has(property) && !isImportant)) continue;
          declared[property] = value;
          if (isImportant) important.add(property);
        }
      };
      for (const { userAgent, declarations } of blocks) {
        const style = document.createElement('div').style;
        for (const { name, value, important: isImportant } of declarations) {
          if (!isImportant) style.setProperty(name, value);
        }
        for (const { name, value, important: isImportant } of declarations) {
          if (isImportant) style.setProperty(name, value, 'important');
        }
        if (!userAgent) for (const name of style) names.add(name);
        take(style);
      }
      const authored = CSS_PROPERTIES.filter((property) =>
        [...physical.get(property), ...logical.get(property)].some((name) => names.has(name))
      );
      return { authored, declared };
    };
    const CSS_VARIABLE_LIMIT = 300;
    const cssVariables = (cs, names) => {
      const colors = [];
      const lengths = [];
      for (const name of names) {
        const value = cs.getPropertyValue(name).trim();
        if (!value) continue;
        if (CSS.supports('outline-offset', value) && !CSS.supports('flex-grow', value)) {
          if (lengths.length < CSS_VARIABLE_LIMIT) lengths.push({ name, value });
        } else if (CSS.supports('color', value) && colors.length < CSS_VARIABLE_LIMIT) {
          colors.push({ name, value });
        }
      }
      return { colors, lengths };
    };
    const cssRounded = (value) =>
      value.replace(
        /(?<![\\w#.-])-?(\\d+\\.?\\d*|\\.\\d+)(e[+-]?\\d+)?([a-z%]*)/g,
        (token, digits, exponent, unit) => {
          const amount = parseFloat(token);
          if (unit && Math.abs(amount) >= 1e6) return (amount < 0 ? '-' : '') + '9999' + unit;
          return exponent || digits.includes('.') ? Math.round(amount * 100) / 100 + unit : token;
        }
      );
    const readCss = (uid, matched) => {
      const el = trackedElementForUid(uid);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const { authored, declared } = cssDeclared(matched.blocks ?? []);
      const values = {};
      for (const property of CSS_PROPERTIES) {
        const own = declared[property];
        values[property] =
          own && /^-?[\\d.]+[a-z%]*( -?[\\d.]+[a-z%]*)*$/.test(own)
            ? own
            : cssRounded(cs.getPropertyValue(property));
      }
      const tag = el.tagName.toUpperCase();
      const hasText = Array.from(el.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== ''
      );
      const { top, left, width, height } = el.getBoundingClientRect();
      return {
        rendersText: !CSS_REPLACED_TAGS.has(tag) && (hasText || CSS_TEXT_TAGS.has(tag)),
        values,
        authored,
        variables: cssVariables(cs, matched.variableNames ?? []),
        rect: { top, left, width, height },
      };
    };
    return { markCss, unmarkCss, readCss, previewCss, renderPreview };
  };

  const pageMarquee = () => {
    const DRAG_THRESHOLD = 5;
    const MIN_REGION_PX = 12;
    const REGION_SHIFT_LOCK_PX = 3;
    const rectBetween = (a, b) => ({
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    });
    const movedRect = (rect, by) => ({ ...rect, x: rect.x + by.x, y: rect.y + by.y });
    const movedPoint = (point, by) => ({ x: point.x + by.x, y: point.y + by.y });
    const sizedMarquee = (anchor, pointer, keys, shiftLock) => {
      const live = keys.alt
        ? rectBetween({ x: 2 * anchor.x - pointer.x, y: 2 * anchor.y - pointer.y }, pointer)
        : rectBetween(anchor, pointer);
      if (!keys.shiftArmed) return { rect: live, shiftLock: null };
      const armed = shiftLock ?? { pointer, frozen: live, axis: null };
      let axis = armed.axis;
      if (axis === null) {
        const dx = Math.abs(pointer.x - armed.pointer.x);
        const dy = Math.abs(pointer.y - armed.pointer.y);
        if (dx >= REGION_SHIFT_LOCK_PX || dy >= REGION_SHIFT_LOCK_PX) axis = dx >= dy ? 'x' : 'y';
      }
      const next = { ...armed, axis };
      const { frozen } = armed;
      if (axis === 'x')
        return { rect: { ...live, y: frozen.y, height: frozen.height }, shiftLock: next };
      if (axis === 'y')
        return { rect: { ...live, x: frozen.x, width: frozen.width }, shiftLock: next };
      return { rect: frozen, shiftLock: next };
    };
    const draggingMarquee = (origin, pointer, keys, previous) => {
      let { originShift, shiftLock, space } = previous;
      if (!keys.space && space !== null) {
        const moved = { x: pointer.x - space.pointer.x, y: pointer.y - space.pointer.y };
        originShift = movedPoint(originShift, moved);
        shiftLock = shiftLock && {
          ...shiftLock,
          pointer: movedPoint(shiftLock.pointer, moved),
          frozen: movedRect(shiftLock.frozen, moved),
        };
        space = null;
      }
      if (keys.space) {
        space ??= {
          pointer,
          rect:
            previous.rect ??
            sizedMarquee(movedPoint(origin, originShift), pointer, keys, shiftLock).rect,
        };
        const rect = movedRect(space.rect, {
          x: pointer.x - space.pointer.x,
          y: pointer.y - space.pointer.y,
        });
        return { kind: 'dragging', origin, pointer, keys, originShift, shiftLock, space, rect };
      }
      const sized = sizedMarquee(movedPoint(origin, originShift), pointer, keys, shiftLock);
      return {
        kind: 'dragging',
        origin,
        pointer,
        keys,
        originShift,
        shiftLock: sized.shiftLock,
        space: null,
        rect: sized.rect,
      };
    };
    const reduceMarquee = (state, input) => {
      if (state.kind === 'cancelled') return state;
      if (input.type === 'key' && input.key === 'Escape')
        return input.down ? { kind: 'cancelled' } : state;
      const was = state.keys;
      let keys;
      if (input.type === 'move') {
        keys = {
          alt: input.altKey,
          shiftDown: input.shiftKey,
          shiftArmed: input.shiftKey && (was.shiftArmed || !was.shiftDown),
          space: was.space,
        };
      } else if (input.key === 'Shift') {
        keys = {
          ...was,
          shiftDown: input.down,
          shiftArmed: input.down && (was.shiftArmed || !was.shiftDown),
        };
      } else if (input.key === 'Alt') {
        keys = { ...was, alt: input.down };
      } else {
        keys = { ...was, space: input.down };
      }
      const pointer = input.type === 'move' ? input.point : state.pointer;
      if (state.kind === 'pressed') {
        if (Math.hypot(pointer.x - state.origin.x, pointer.y - state.origin.y) < DRAG_THRESHOLD)
          return { ...state, pointer, keys };
        return draggingMarquee(state.origin, pointer, keys, {
          originShift: { x: 0, y: 0 },
          shiftLock: null,
          space: null,
          rect: null,
        });
      }
      return draggingMarquee(state.origin, pointer, keys, state);
    };
    const finishMarquee = (state, input, bounds) => {
      const final = reduceMarquee(state, input);
      if (final.kind === 'cancelled') return { kind: 'dropped' };
      if (final.kind === 'pressed') return { kind: 'click' };
      const x = Math.max(final.rect.x, 0);
      const y = Math.max(final.rect.y, 0);
      const width = Math.max(0, Math.min(final.rect.x + final.rect.width, bounds.width) - x);
      const height = Math.max(0, Math.min(final.rect.y + final.rect.height, bounds.height) - y);
      return width < MIN_REGION_PX || height < MIN_REGION_PX
        ? { kind: 'dropped' }
        : { kind: 'region', rect: { x, y, width, height } };
    };
    return { reduceMarquee, finishMarquee };
  };

  const installElementDescription = (ctx) => {
    const { uniqueIdOf } = ctx;
    const classNameOf = (element) => {
      const value = element.className;
      if (typeof value === 'string') return value;
      return value instanceof SVGAnimatedString ? value.baseVal : '';
    };
    const classSignature = (element) =>
      classNameOf(element).trim().split(/\\s+/).filter(Boolean).sort().join('.');
    const elementPath = (element) => {
      const body = element.ownerDocument.body;
      const path = [];
      let node = element;
      while (node !== null && node !== body) {
        let segment = node.tagName.toLowerCase();
        const classes = classNameOf(node).trim().split(/\\s+/).filter(Boolean);
        if (node.id) segment += \`#\${node.id}\`;
        else if (classes.length > 0) segment += \`.\${classes.join('.')}\`;
        const parent = node.parentElement;
        if (parent !== null && !node.id) {
          const current = node;
          const same = Array.from(parent.children).filter(
            (sibling) =>
              sibling.tagName === current.tagName &&
              classSignature(sibling) === classSignature(current)
          );
          if (same.length > 1) segment += \`[\${same.indexOf(current)}]\`;
        }
        path.unshift(segment);
        node = parent;
      }
      return path.join(' > ');
    };
    const COMPONENT_QUERY = 'molten-picker-component-query';
    const COMPONENT_RESULT = 'molten-picker-component-result';
    const componentOf = (element) => {
      let reply = null;
      const listen = (event) => {
        reply = 'detail' in event ? event.detail : undefined;
      };
      window.addEventListener(COMPONENT_RESULT, listen);
      element.dispatchEvent(new CustomEvent(COMPONENT_QUERY, { composed: true }));
      window.removeEventListener(COMPONENT_RESULT, listen);
      if (typeof reply !== 'string') return null;
      let info;
      try {
        info = JSON.parse(reply);
      } catch {
        return null;
      }
      if (typeof info !== 'object' || info === null) return null;
      const framework = 'framework' in info ? info.framework : undefined;
      const stack = 'stack' in info ? info.stack : undefined;
      if (framework !== 'react' && framework !== 'vue' && framework !== 'svelte') return null;
      if (!Array.isArray(stack)) return null;
      const names = stack.filter((name) => typeof name === 'string' && name.length > 0).slice(0, 5);
      return names.length === 0 ? null : { framework, stack: names };
    };
    const elementText = (element) =>
      element instanceof HTMLElement ? element.innerText : (element.textContent ?? '');
    const describeElement = (element, hueIndex) => {
      const box = element.getBoundingClientRect();
      const computed = getComputedStyle(element);
      const component = componentOf(element);
      const text = elementText(element);
      return {
        tagName: element.tagName.slice(0, 128),
        id: element.id.slice(0, 1e4),
        uniqueId: uniqueIdOf(element),
        className: classNameOf(element).slice(0, 2e4),
        innerText: text.slice(0, 200),
        path: elementPath(element).slice(0, 2e4),
        attributes: Array.from(element.attributes)
          .slice(0, 100)
          .map((attribute) => ({
            name: attribute.name.slice(0, 512),
            value: attribute.value.slice(0, 1e4),
          })),
        rect: { top: box.top, left: box.left, width: box.width, height: box.height },
        styles: {
          color: computed.color.slice(0, 1e3),
          backgroundColor: computed.backgroundColor.slice(0, 1e3),
          fontSize: computed.fontSize.slice(0, 1e3),
          fontFamily: computed.fontFamily.slice(0, 2e3),
          display: computed.display.slice(0, 1e3),
          position: computed.position.slice(0, 1e3),
        },
        component: component?.stack[0]?.slice(0, 1e3),
        componentStack: component?.stack.map((name) => name.slice(0, 1e3)),
        framework: component?.framework,
        hueIndex,
      };
    };
    return { classNameOf, classSignature, componentOf, elementText, describeElement };
  };

  const HUES = [
    '58,150,221',
    '155,89,182',
    '39,174,96',
    '242,153,74',
    '0,184,169',
    '219,68,134',
    '235,87,87',
    '170,175,18',
  ];
  const OVERLAY_TAG = 'MOLTEN-GLASS-OVERLAY';
  const makeHost = (cssText) => {
    const host = document.createElement(OVERLAY_TAG.toLowerCase());
    host.style.cssText =
      'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    root.adoptedStyleSheets = [sheet];
    document.documentElement.appendChild(host);
    return { host, root };
  };
  const { reduceMarquee, finishMarquee } = pageMarquee();
  let design = null;
  const nextFrame = () =>
    new Promise((resolve) => {
      requestAnimationFrame(() => resolve(null));
    });
  const pushDesign = (event) => {
    sendBinding(event);
  };
  const pushPainted = (event) => {
    void nextFrame().then(nextFrame).then(() => pushDesign(event));
  };

  const uniqueIds = new WeakMap();
  const uniquePrefix = \`cursor-el-\${Math.random().toString(36).slice(2, 7)}-\`;
  let uniqueCount = 0;
  const elementsByUid = new Map();
  const bindUid = (element, uid) => {
    uniqueIds.set(element, uid);
    elementsByUid.set(uid, new WeakRef(element));
  };
  const uniqueIdOf = (element) => {
    let id = uniqueIds.get(element);
    if (id === undefined) {
      uniqueCount += 1;
      id = \`\${uniquePrefix}\${uniqueCount}\`;
      bindUid(element, id);
    }
    return id;
  };
  const css = installCss(() =>
    [...elementsByUid].flatMap(([uid, ref]) => {
      const el = ref.deref();
      return el === undefined ? [] : [{ uid, el }];
    })
  );
  const restyle = () => css.renderPreview();
  const { classNameOf, classSignature, componentOf, elementText, describeElement } =
    installElementDescription({ uniqueIdOf });

  const rectOf = (element) => {
    const box = element.getBoundingClientRect();
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  };
  const identityParts = (element) => {
    const tag = element.tagName.toLowerCase();
    const component = componentOf(element)?.stack[0] ?? '';
    const firstClass = element.classList[0];
    let mark = '';
    if (component.length === 0) {
      if (element.id.length > 0) mark = \`#\${element.id}\`;
      else if (firstClass !== undefined) mark = \`.\${firstClass}\`;
    }
    return { tag, component, mark };
  };
  const hueOf = (element) =>
    design?.hues.get(uniqueIdOf(element)) ?? (design?.hueIndex ?? 0) % HUES.length;
  const picked = (element) => {
    const { tag, component } = identityParts(element);
    return {
      tag,
      component,
      rect: rectOf(element),
      uid: uniqueIdOf(element),
      hueIndex: hueOf(element),
    };
  };
  const elementAt = (x, y) =>
    document.elementsFromPoint(x, y).find((element) => element.tagName !== OVERLAY_TAG) ?? null;
  const placeBox = (box, rect) => {
    box.style.left = \`\${rect.x}px\`;
    box.style.top = \`\${rect.y}px\`;
    box.style.width = \`\${rect.width}px\`;
    box.style.height = \`\${rect.height}px\`;
  };
  const renderSelected = () => {
    if (design === null) return;
    design.boxes.replaceChildren(
      ...design.selected.map((element) => {
        const hue = HUES[hueOf(element)];
        const box = document.createElement('div');
        box.className = 'box';
        box.style.border = \`2px solid rgba(\${hue},1)\`;
        box.style.background = \`rgba(\${hue},0.1)\`;
        placeBox(box, rectOf(element));
        return box;
      })
    );
  };
  const renderHover = (element) => {
    if (design === null) return;
    design.hovered = element;
    if (element === null) design.walk = null;
    if (element === null || design.frozen) {
      design.hover.style.display = 'none';
      design.pill.style.display = 'none';
      return;
    }
    const rect = rectOf(element);
    design.hover.style.display = 'block';
    placeBox(design.hover, rect);
    const { tag, component, mark } = identityParts(element);
    const pill = design.pill;
    pill.replaceChildren();
    let segments;
    if (component.length > 0) {
      segments = [
        [component, 1],
        ['\\xB7', 0.55],
        [tag, 0.75],
      ];
    } else if (mark.length > 0) {
      segments = [
        [tag, 0.75],
        [mark, 1],
      ];
    } else {
      segments = [[tag, 0.75]];
    }
    for (const [segmentText, opacity] of segments) {
      const segment = document.createElement('span');
      segment.className = 'segment';
      segment.style.opacity = String(opacity);
      segment.textContent = segmentText;
      pill.append(segment);
    }
    pill.style.display = 'block';
    const height = pill.offsetHeight;
    const above = rect.y - height - 6;
    pill.style.left = \`\${Math.max(4, Math.min(rect.x, window.innerWidth - pill.offsetWidth - 4))}px\`;
    pill.style.top = \`\${above >= 4 ? above : Math.min(rect.y + rect.height + 6, window.innerHeight - height - 4)}px\`;
  };
  const hoverTarget = (underPointer) => {
    if (design === null) return underPointer;
    if (design.walk !== null && design.walk[0] === underPointer) return design.walk.at(-1) ?? null;
    design.walk = null;
    return underPointer;
  };
  const designWalk = (direction) => {
    if (design === null || design.frozen || design.marquee !== null || design.selected.length > 0)
      return false;
    const hovered = design.hovered;
    if (hovered === null) return false;
    if (design.walk?.at(-1) !== hovered) design.walk = [hovered];
    const walk = design.walk;
    if (direction === 'up') {
      const parent = hovered.parentElement;
      if (parent === null || parent === document.body || parent === document.documentElement)
        return true;
      walk.push(parent);
    } else if (walk.length > 1) {
      walk.pop();
    }
    renderHover(walk.at(-1) ?? null);
    return true;
  };
  const endMarquee = () => {
    if (design?.marquee == null) return;
    const drew = design.marquee.kind === 'dragging';
    design.marquee = null;
    design.marqueeBox.style.display = 'none';
    if (drew) pushDesign({ type: 'drawing', drawing: false });
  };
  const stepMarquee = (input) => {
    if (design?.marquee == null) return;
    const was = design.marquee;
    const next = reduceMarquee(was, input);
    if (next.kind === 'cancelled') {
      endMarquee();
      return;
    }
    design.marquee = next;
    if (next.kind !== 'dragging') return;
    if (was.kind === 'pressed') {
      renderHover(null);
      pushDesign({ type: 'drawing', drawing: true });
    }
    placeBox(design.marqueeBox, next.rect);
    design.marqueeBox.style.display = 'block';
  };
  const designCancelGesture = () => {
    if (design?.marquee == null) return false;
    stepMarquee({ type: 'key', key: 'Escape', down: true });
    return true;
  };
  const emitSelection = (addToChat) => {
    if (design === null || design.selected.length === 0) return;
    design.frozen = true;
    renderHover(null);
    renderSelected();
    pushPainted({
      type: 'select',
      elements: design.selected.map(picked),
      region: null,
      addToChat,
      viewportWidth: window.innerWidth,
    });
  };
  const pickPositions = new WeakMap();
  const textOf = (element) => (element.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  const positionsOf = (element) => {
    const positions = [];
    for (let node = element; node !== null && node !== document.body; ) {
      const parent = node.parentElement;
      const tag = node.tagName;
      const same =
        parent === null
          ? [node]
          : Array.from(parent.children).filter((sibling) => sibling.tagName === tag);
      positions.unshift([tag, same.indexOf(node), same.length]);
      node = parent;
    }
    return positions;
  };
  const atPositions = (positions) => {
    let node = document.body;
    for (const [tag, index, count] of positions) {
      if (!node) return null;
      const same = Array.from(node.children).filter((child) => child.tagName === tag);
      const next = same[index];
      if (same.length !== count || next === undefined) return null;
      node = next;
    }
    return node;
  };
  const select = (element) => {
    if (design === null || design.selected.includes(element)) return;
    pickPositions.set(element, positionsOf(element));
    design.hues.set(uniqueIdOf(element), (design.hueIndex + design.selected.length) % HUES.length);
    design.selected.push(element);
  };
  const reattachPicks = (added) => {
    if (design === null) return false;
    const next = [...design.selected];
    const lost = next.flatMap((element, index) =>
      element.isConnected ? [] : [{ element, index }]
    );
    if (lost.length === 0) return false;
    const inserted = new Set(
      added.flatMap((root) =>
        root instanceof Element && root.isConnected ? [root, ...root.querySelectorAll('*')] : []
      )
    );
    const claimed = new Set(next.filter((element) => element.isConnected));
    const wanted = lost.map(({ element, index }) => {
      const positions = pickPositions.get(element);
      const at = element.id.length > 0 || positions === undefined ? null : atPositions(positions);
      return {
        index,
        tag: element.tagName,
        id: element.id,
        classes: classSignature(element),
        text: textOf(element),
        slot: at !== null && inserted.has(at) ? at : null,
      };
    });
    const uniqueMatch = ({ tag, id, classes, text }) => {
      const matches = [...inserted].filter(
        (candidate) =>
          candidate.tagName === tag &&
          !claimed.has(candidate) &&
          candidate.id === id &&
          (id.length > 0 || (classSignature(candidate) === classes && textOf(candidate) === text))
      );
      return matches.length === 1 ? (matches[0] ?? null) : null;
    };
    const steps = [
      ({ slot, text }) => (slot !== null && text.length > 0 && textOf(slot) === text ? slot : null),
      uniqueMatch,
      ({ slot, classes }) =>
        slot !== null && classes.length > 0 && classSignature(slot) === classes ? slot : null,
    ];
    let moved = false;
    for (const step of steps) {
      for (const item of wanted) {
        const was = next[item.index];
        if (was === undefined || was.isConnected) continue;
        const element = step(item);
        if (element === null || claimed.has(element)) continue;
        claimed.add(element);
        const uid = uniqueIds.get(was);
        if (uid !== undefined) bindUid(element, uid);
        next[item.index] = element;
        moved = true;
      }
    }
    design.selected = next.filter((element) => element.isConnected);
    return moved;
  };
  const resendPick = () => {
    void nextFrame().then(nextFrame).then(() => {
      if (design?.frozen !== true) return;
      const elements = design.selected.map(picked);
      pushDesign({
        type: 'select',
        elements,
        region: null,
        addToChat: false,
        viewportWidth: window.innerWidth,
      });
    });
  };

  const pins = installPagePins(
    {
      overlayTag: OVERLAY_TAG,
      designOn: () => design !== null,
      push: pushDesign,
      clearHover: () => renderHover(null),
      elementOf: (uid) => elementsByUid.get(uid)?.deref(),
      adopt: (element, uid) => {
        if (design?.selected.includes(element) !== true) uniqueIds.set(element, uid);
        elementsByUid.set(uid, new WeakRef(element));
      },
      restyle,
      classNameOf,
      elementText,
      makeHost,
      placeBox,
      nextFrame,
      rulerInset: () => 0,
    },
    pinGeometry()
  );

  const onPageMutations = (records) => {
    if (design === null) return;
    pins.noteMutations(records);
    if (design.selected.length === 0) return;
    const added = [];
    const targets = [];
    for (const record of records) {
      if (
        [...record.addedNodes, ...record.removedNodes].every((n) => n.nodeName === OVERLAY_TAG)
      )
        continue;
      targets.push(record.target);
      added.push(...record.addedNodes);
    }
    if (targets.length === 0) return;
    const picks = design.selected.length;
    if (reattachPicks(added)) restyle();
    for (const element of design.selected) {
      if (targets.some((target) => target.contains(element)))
        pickPositions.set(element, positionsOf(element));
    }
    renderSelected();
    if (design.frozen && design.selected.length !== picks) resendPick();
  };
  const onResize = () => {
    if (design === null || design.selected.length === 0) return;
    renderSelected();
    if (design.frozen) resendPick();
  };

  const DESIGN_CSS = \`
    .layer { position: fixed; inset: 0; pointer-events: auto; cursor: url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2722%27 height=%2722%27 viewBox=%270 0 22 22%27%3E%3Cpath transform=%27translate(3 19.5) scale(0.05333 -0.05333)%27 d=%27M155 293Q192 293 224 274.5Q256 256 274.5 224Q293 192 293 154.5Q293 117 274.5 85.5Q256 54 224 35Q192 16 155 16L28 16Q23 16 19.5 19.5Q16 23 16 28L16 155Q16 192 35 224Q54 256 85.5 274.5Q117 293 155 293Z%27 fill=%27none%27 stroke=%27rgba(0,0,0,0.22)%27 stroke-width=%2780%27 stroke-linejoin=%27round%27/%3E%3Cpath transform=%27translate(3 19) scale(0.05333 -0.05333)%27 d=%27M155 293Q192 293 224 274.5Q256 256 274.5 224Q293 192 293 154.5Q293 117 274.5 85.5Q256 54 224 35Q192 16 155 16L28 16Q23 16 19.5 19.5Q16 23 16 28L16 155Q16 192 35 224Q54 256 85.5 274.5Q117 293 155 293Z%27 fill=%27white%27 stroke=%27white%27 stroke-width=%2756%27 stroke-linejoin=%27round%27/%3E%3Cpath transform=%27translate(3 19) scale(0.05333 -0.05333)%27 d=%27M155 293Q192 293 224 274.5Q256 256 274.5 224Q293 192 293 154.5Q293 117 274.5 85.5Q256 54 224 35Q192 16 155 16L28 16Q23 16 19.5 19.5Q16 23 16 28L16 155Q16 192 35 224Q54 256 85.5 274.5Q117 293 155 293Z%27 fill=%27rgb(58,150,221)%27/%3E%3C/svg%3E") 4 18, crosshair; }
    .box { position: fixed; box-sizing: border-box; pointer-events: none; border-radius: 0; }
    .hover { border: 2px solid rgba(58,150,221,0.5); background: rgba(58,150,221,0.02); display: none; }
    .pill .segment + .segment { margin-left: 4px; }
    .pill { position: fixed; display: none; pointer-events: none; background: rgba(58,150,221,0.9); color: #fff;
      padding: 6px 12px; border-radius: 8px; font: 500 13px system-ui, sans-serif; line-height: 18px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-width: 320px; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }
    .marquee { position: fixed; display: none; box-sizing: border-box; border: 2px dashed #3a96dd;
      pointer-events: none; }
  \`;

  const designStart = () => {
    if (design !== null) {
      if (design.host.isConnected) return true;
      design.detach();
      design = null;
    }
    const { host, root } = makeHost(DESIGN_CSS);
    const layer = document.createElement('div');
    layer.className = 'layer';
    const hover = document.createElement('div');
    hover.className = 'box hover';
    const boxes = document.createElement('div');
    const pill = document.createElement('div');
    pill.className = 'pill';
    const marqueeBox = document.createElement('div');
    marqueeBox.className = 'marquee';
    root.append(layer, boxes, hover, marqueeBox, pill);
    const onMove = (event) => {
      if (design === null) return;
      if (design.marquee !== null) {
        stepMarquee({
          type: 'move',
          point: { x: event.clientX, y: event.clientY },
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        });
        return;
      }
      if (design.frozen || pins.opened()) return;
      const target = hoverTarget(elementAt(event.clientX, event.clientY));
      if (target !== design.hovered) renderHover(target);
    };
    const onDown = (event) => {
      if (design === null || event.button !== 0) return;
      event.preventDefault();
      if (design.frozen) return;
      const origin = { x: event.clientX, y: event.clientY };
      design.marquee = {
        kind: 'pressed',
        origin,
        pointer: origin,
        keys: { alt: event.altKey, shiftDown: event.shiftKey, shiftArmed: false, space: false },
      };
      try {
        layer.setPointerCapture(event.pointerId);
      } catch {}
    };
    const onUp = (event) => {
      if (design === null) return;
      const marquee = design.marquee;
      if (marquee === null) return;
      endMarquee();
      const result = finishMarquee(
        marquee,
        {
          type: 'move',
          point: { x: event.clientX, y: event.clientY },
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        },
        { width: layer.clientWidth, height: layer.clientHeight }
      );
      if (result.kind === 'dropped') return;
      if (result.kind === 'region') {
        design.selected = [];
        design.frozen = true;
        renderHover(null);
        boxes.replaceChildren();
        pushPainted({
          type: 'select',
          elements: [],
          region: result.rect,
          addToChat: false,
          viewportWidth: window.innerWidth,
        });
        return;
      }
      if (design.frozen) return;
      const target = hoverTarget(elementAt(event.clientX, event.clientY));
      design.walk = null;
      if (target === null) return;
      if (event.altKey) design.hueIndex += 1;
      if (event.shiftKey) {
        const index = design.selected.indexOf(target);
        if (index >= 0) design.selected.splice(index, 1);
        else select(target);
        renderSelected();
        return;
      }
      select(target);
      emitSelection(event.altKey);
    };
    const usesArrowKeys = (target) =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    const marqueeKey = (event) => {
      if (event.key === ' ') return 'Space';
      if (event.key === 'Shift' || event.key === 'Alt' || event.key === 'Escape') return event.key;
      return null;
    };
    const marqueeKeyEvent = (event, down) => {
      if (design?.marquee == null) return false;
      const key = marqueeKey(event);
      if (key === null) return false;
      if (key === 'Space' || key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      stepMarquee({ type: 'key', key, down });
      return true;
    };
    const onKeyDown = (event) => {
      if (marqueeKeyEvent(event, true)) return;
      if (event.key === 'Escape' && design !== null && !design.frozen) {
        event.preventDefault();
        event.stopPropagation();
        sendBinding({ type: 'cancelled' });
        return;
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.composedPath()[0];
      if (target instanceof Element && target.tagName === OVERLAY_TAG) return;
      if (usesArrowKeys(target)) return;
      if (designWalk(event.key === 'ArrowUp' ? 'up' : 'down')) event.preventDefault();
    };
    const onKeyUp = (event) => {
      if (marqueeKeyEvent(event, false)) return;
      if (
        event.key === 'Shift' &&
        design !== null &&
        !design.frozen &&
        design.selected.length > 0
      ) {
        emitSelection(false);
      }
    };
    const onScroll = () => {
      if (design === null) return;
      renderSelected();
      if (design.hovered !== null) renderHover(design.hovered);
      pins.layout();
    };
    const onContext = (event) => event.preventDefault();
    const onLost = () => stepMarquee({ type: 'key', key: 'Escape', down: true });
    const onLeave = () => renderHover(null);
    layer.addEventListener('pointermove', onMove);
    layer.addEventListener('pointerleave', onLeave);
    layer.addEventListener('pointerdown', onDown);
    layer.addEventListener('pointerup', onUp);
    layer.addEventListener('pointercancel', onLost);
    layer.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onLost);
    const observer = new MutationObserver(onPageMutations);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    design = {
      host,
      hover,
      pill,
      boxes,
      hovered: null,
      walk: null,
      selected: [],
      hueIndex: 0,
      hues: new Map(),
      frozen: false,
      marquee: null,
      marqueeBox,
      detach: () => {
        observer.disconnect();
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('blur', onLost);
        host.remove();
      },
    };
    pins.start();
    return true;
  };

  const designStop = () => {
    css.previewCss('queue', {});
    css.previewCss('draft', {});
    if (design === null) return true;
    design.detach();
    design = null;
    pins.stop();
    return true;
  };
  const designClear = () => {
    if (design === null) return false;
    design.selected = [];
    design.frozen = false;
    design.boxes.replaceChildren();
    return true;
  };
  const designMove = (direction) => {
    if (design === null) return [];
    const current = design.selected[0];
    if (current === undefined) return [];
    let next = null;
    if (direction === 'parent')
      next = current.parentElement === document.documentElement ? null : current.parentElement;
    else if (direction === 'child') next = current.firstElementChild;
    else if (direction === 'next') next = current.nextElementSibling;
    else if (direction === 'previous') next = current.previousElementSibling;
    if (next !== null) {
      design.selected = [];
      select(next);
    }
    renderSelected();
    return design.selected.map(picked);
  };
  const designDescribe = () => {
    if (design === null) return [];
    return design.selected.map((element) => describeElement(element, hueOf(element)));
  };
  const designRegionAnchor = ({ x, y }) => {
    const hit = elementAt(x, y);
    const anchor =
      hit === null || hit === document.body || hit === document.documentElement
        ? document.documentElement
        : hit;
    return describeElement(anchor, 0);
  };
  const designReflow = () => {
    renderSelected();
    pins.layout();
  };
  const captureChrome = (shown) => {
    const hosts = [design?.host, pins.host()].filter((h) => h !== undefined && h !== null);
    for (const h of hosts) h.style.visibility = shown ? '' : 'hidden';
    if (shown || hosts.length === 0) return hosts.length > 0;
    return nextFrame().then(nextFrame).then(() => true);
  };
  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

  const api = {
    designStart,
    designStop,
    designClear,
    designCancelGesture,
    designMove,
    designWalk,
    designDescribe,
    designRegionAnchor,
    designPins: pins.set,
    designPinOpen: pins.open,
    markCss: css.markCss,
    unmarkCss: css.unmarkCss,
    readCss: css.readCss,
    previewCss: (slot, spec) => {
      const rect = css.previewCss(slot, spec);
      designReflow();
      return rect;
    },
    captureChrome,
    viewport,
  };
  window.__ensoDesignRuntime = api;
  return api;
})()`;

export function pageDesignRuntimeCallScript(method: string, args: readonly unknown[] = []): string {
  return `(() => {
    const rt = window.__ensoDesignRuntime ?? ${PAGE_DESIGN_RUNTIME_SCRIPT};
    const fn = rt[${JSON.stringify(method)}];
    return typeof fn === 'function' ? fn(...${JSON.stringify(args)}) : undefined;
  })()`;
}
