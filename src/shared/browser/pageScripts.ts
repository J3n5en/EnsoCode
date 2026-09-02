/**
 * 注入 guest 页执行的脚本源码（`webContents.executeJavaScript`）。
 * 打 `data-enso-ref` 标记可交互元素，抽扁平条目给 `parseSnapshotEntries`。
 * 点击 / 输入走 DOM 事件，不用 CDP `Input.*`。
 */

import { DESIGN_SCRIBBLE_HOLD_MS, DESIGN_SCRIBBLE_MOVE_PX } from './designMode';

const REF_ATTR = 'data-enso-ref';

export const PAGE_SNAPSHOT_SCRIPT = `(() => {
  const REF_ATTR = ${JSON.stringify(REF_ATTR)};
  const MAX = 1500;
  const INTERACTIVE = new Set(['a','button','input','select','textarea','summary','option']);
  const LANDMARK = { header:'banner', nav:'navigation', main:'main', footer:'contentinfo', aside:'complementary', form:'form', section:'region', article:'article', dialog:'dialog', table:'table', ul:'list', ol:'list', li:'listitem', img:'img', h1:'heading', h2:'heading', h3:'heading', h4:'heading', h5:'heading', h6:'heading', p:'paragraph', label:'label' };
  for (const old of document.querySelectorAll('[' + REF_ATTR + ']')) old.removeAttribute(REF_ATTR);
  let counter = 0;
  const out = [];
  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const isInteractive = (el) => {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE.has(tag)) return tag !== 'input' || el.type !== 'hidden';
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute('role');
    return ['button','link','checkbox','radio','tab','menuitem','switch','textbox','combobox','option','slider'].includes(role || '');
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
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (el.isContentEditable) return 'textbox';
    return LANDMARK[tag] || 'generic';
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
  const walk = (node, depth) => {
    if (out.length >= MAX) return;
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg' || tag === 'template') return;
    if (!visible(node)) return;
    const interactive = isInteractive(node);
    const role = roleOf(node);
    const structural = LANDMARK[tag] !== undefined;
    let nextDepth = depth;
    if (interactive || structural) {
      const entry = { role, name: nameOf(node), depth };
      if (interactive) {
        const ref = 'e' + (++counter);
        node.setAttribute(REF_ATTR, ref);
        entry.ref = ref;
        const value = valueOf(node);
        if (value) entry.value = value.length > 200 ? value.slice(0, 200) + '…' : value;
      }
      out.push(entry);
      nextDepth = depth + 1;
      if (interactive && tag !== 'li' && tag !== 'form') return;
    } else if (node.childElementCount === 0) {
      const text = (node.textContent || '').trim();
      if (text && text.length <= 400) out.push({ role: 'text', name: text, depth });
      return;
    }
    for (const child of node.children) walk(child, nextDepth);
  };
  walk(document.body, 0);
  return out;
})()`;

const findByRef = (ref: string) =>
  `document.querySelector('[${REF_ATTR}=' + ${JSON.stringify(JSON.stringify(ref))} + ']')`;

/** 返回 'ok' | 'stale'；点击走 scrollIntoView + 可信 click()。 */
export const pageClickScript = (ref: string): string => `(() => {
  const el = ${findByRef(ref)};
  if (!el) return 'stale';
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof el.focus === 'function') el.focus();
  el.click();
  return 'ok';
})()`;

/** 返回 'ok' | 'stale' | 'not-editable'；先清空再填，触发 input/change，可选回车。 */
export const pageTypeScript = (ref: string, text: string, submit: boolean): string => `(() => {
  const el = ${findByRef(ref)};
  if (!el) return 'stale';
  el.scrollIntoView({ block: 'center', inline: 'center' });
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
  return 'ok';
})()`;

const LOCK_OVERLAY_ID = 'enso-browser-lock-overlay';

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

export const PAGE_UNLOCK_OVERLAY_SCRIPT = `(() => {
  document.getElementById(${JSON.stringify(LOCK_OVERLAY_ID)})?.remove();
  return 'ok';
})()`;

export const pageSelectOptionScript = (ref: string, values: string[]): string => `(() => {
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
  return 'ok';
})()`;

export const pagePressKeyScript = (key: string): string => `(() => {
  const el = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const key = ${JSON.stringify(key)};
  const init = { key, code: key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  if (key === 'Enter' && el instanceof HTMLElement && el.form && typeof el.form.requestSubmit === 'function') {
    el.form.requestSubmit();
  }
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
    return `(() => {
      const el = ${findByRef(opts.ref)};
      if (!el) return 'stale';
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.scrollBy({ top: ${dir * amount}, behavior: 'instant' });
      return 'ok';
    })()`;
  }
  return `(() => { window.scrollBy({ top: ${dir * amount}, behavior: 'instant' }); return 'ok'; })()`;
};

/** 锁定遮罩会挡住 elementFromPoint；命中测试期间临时隐藏。 */
const hitTest = `(x, y) => {
  const overlay = document.getElementById(${JSON.stringify(LOCK_OVERLAY_ID)});
  if (overlay) overlay.style.display = 'none';
  try { return document.elementFromPoint(x, y); } finally { if (overlay) overlay.style.display = ''; }
}`;

export const pageClickXyScript = (x: number, y: number): string => `(() => {
  const x = ${JSON.stringify(x)}, y = ${JSON.stringify(y)};
  const el = (${hitTest})(x, y);
  if (!(el instanceof HTMLElement)) return 'miss';
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
  el.click();
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

export const pageDragScript = (
  from: { ref?: string; x?: number; y?: number },
  to: { ref?: string; x?: number; y?: number }
): string => `(() => {
  const hit = ${hitTest};
  const point = (spec) => {
    if (spec.ref) {
      const el = document.querySelector('[${REF_ATTR}=' + JSON.stringify(spec.ref) + ']');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { el, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return { el: hit(spec.x, spec.y), x: spec.x, y: spec.y };
  };
  const from = point(${JSON.stringify(from)});
  const to = point(${JSON.stringify(to)});
  if (!from || !to) return 'stale';
  const start = from.el instanceof HTMLElement ? from.el : document.body;
  start.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: from.x, clientY: from.y, buttons: 1 }));
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: to.x, clientY: to.y, buttons: 1 }));
  const end = to.el instanceof HTMLElement ? to.el : document.body;
  end.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: to.x, clientY: to.y }));
  return 'ok';
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
  });
  const freezeImg = document.createElement('img');
  Object.assign(freezeImg.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'fill',
    pointerEvents: 'none',
    imageRendering: 'auto',
  });
  const draw = document.createElement('canvas');
  Object.assign(draw.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  });
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
    cropImg.style.width = crop.width + 'px';
    cropImg.style.height = crop.height + 'px';
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
    freezeLayer.style.display = 'block';
    hide();
    if (freezeImg.complete) ready();
  };
  const startFreeze = () => {
    if (!enabled || phase === 'freezing' || phase === 'annotating') return;
    phase = 'freezing';
    hide();
    sizeCanvas();
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
