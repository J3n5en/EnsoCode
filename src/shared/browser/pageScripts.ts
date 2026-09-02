/**
 * 注入 guest 页执行的脚本源码（`webContents.executeJavaScript`）。
 * 打 `data-enso-ref` 标记可交互元素，抽扁平条目给 `parseSnapshotEntries`。
 * 点击 / 输入走 DOM 事件，不用 CDP `Input.*`。
 */

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
  const mount = () => {
    if (!root.isConnected) document.documentElement.appendChild(root);
  };
  const hide = () => {
    root.style.visibility = 'hidden';
  };
  const showChrome = () => {
    root.style.visibility = '';
  };
  const paint = (el) => {
    if (!el || !enabled) {
      box.style.display = 'none';
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
  };
  const skip = (el) => el === root || root.contains(el);
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
      if (value) return value.replace(/s+/g, ' ');
    }
    const text = (el.innerText || '').trim().replace(/s+/g, ' ');
    return text ? text.slice(0, 80) : el.tagName.toLowerCase();
  };
  const payload = (el) => {
    const r = el.getBoundingClientRect();
    const className = typeof el.className === 'string' ? el.className : '';
    return {
      label: labelOf(el),
      path: cssPath(el),
      text: (el.innerText || '').trim().replace(/s+/g, ' ').slice(0, 200),
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      className: className || undefined,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  };
  const onMove = (event) => {
    if (!enabled) return;
    event.preventDefault();
    event.stopPropagation();
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
    event.preventDefault();
    event.stopPropagation();
  };
  const onClick = (event) => {
    if (!enabled) return;
    event.preventDefault();
    event.stopPropagation();
    const el = meaningful(event.target);
    if (!el) return;
    send({ type: 'picked', payload: payload(el) });
  };
  const onKey = (event) => {
    if (!enabled || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    send({ type: 'cancelled' });
  };
  const setEnabled = (on) => {
    enabled = on;
    if (on) {
      mount();
      showChrome();
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('mousedown', block, true);
      document.addEventListener('pointerdown', block, true);
      document.addEventListener('keydown', onKey, true);
      return;
    }
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('mousedown', block, true);
    document.removeEventListener('pointerdown', block, true);
    document.removeEventListener('keydown', onKey, true);
    hoverEl = null;
    if (root.isConnected) root.remove();
  };
  window.__ensoDesignMode = { setEnabled, hide, showChrome };
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
