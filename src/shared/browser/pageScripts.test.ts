import { describe, expect, it } from 'vitest';
import {
  DESIGN_MODE_BINDING,
  PAGE_COMPONENT_PROBE_SCRIPT,
  PAGE_DESIGN_MODE_DISABLE_SCRIPT,
  PAGE_DESIGN_MODE_ENABLE_SCRIPT,
  PAGE_DESIGN_MODE_HIDE_SCRIPT,
  PAGE_DESIGN_RUNTIME_SCRIPT,
  PAGE_LOCK_OVERLAY_SCRIPT,
  PAGE_SETTLE_COMBOBOX_MS,
  PAGE_SETTLE_FRAME_MS,
  PAGE_SNAPSHOT_SCRIPT,
  PAGE_UNLOCK_OVERLAY_SCRIPT,
  pageClickScript,
  pageClickXyScript,
  pageDesignRuntimeCallScript,
  pageDragPointsScript,
  pageLockOverlayDisplayScript,
  pagePressKeyScript,
  pageScrollScript,
  pageSelectOptionScript,
  pageTypeScript,
} from './pageScripts';

const runUnlock = (nodes: { id: string }[]): unknown => {
  const document = {
    getElementById: (id: string) => {
      const el = nodes.find((n) => n.id === id);
      return el ? { remove: () => nodes.splice(nodes.indexOf(el), 1) } : null;
    },
  };
  return new Function('document', `return ${PAGE_UNLOCK_OVERLAY_SCRIPT}`)(document);
};

describe('lock overlay scripts', () => {
  it('installs a full-page overlay and can remove it', () => {
    expect(PAGE_LOCK_OVERLAY_SCRIPT).toContain('enso-browser-lock-overlay');
    expect(PAGE_LOCK_OVERLAY_SCRIPT).toContain('preventDefault');
    expect(PAGE_UNLOCK_OVERLAY_SCRIPT).toContain('enso-browser-lock-overlay');
    expect(PAGE_UNLOCK_OVERLAY_SCRIPT).toContain('.remove()');
  });

  it('unlock is idempotent and only reports ok when the node is really gone', () => {
    expect(runUnlock([])).toBe('ok');
    const nodes = [{ id: 'enso-browser-lock-overlay' }, { id: 'enso-browser-lock-overlay' }];
    expect(runUnlock(nodes)).toBe('ok');
    expect(nodes).toHaveLength(0);
  });

  it('unlock reports failure when the overlay survives removal', () => {
    const document = {
      getElementById: (id: string) =>
        id === 'enso-browser-lock-overlay' ? { remove: () => {} } : null,
    };
    const result = new Function('document', `return ${PAGE_UNLOCK_OVERLAY_SCRIPT}`)(document);
    expect(result).not.toBe('ok');
  });
});

describe('design mode scripts', () => {
  it('uses binding + WeakMap-free overlay id, and hide/disable stay self-contained', () => {
    expect(DESIGN_MODE_BINDING).toBe('ensoDesignMode');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('enso-design-mode-root');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('ensoDesignMode');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('__ensoDesignMode');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain("type: 'picked'");
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain("type: 'cancelled'");
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain("addEventListener('pointerup'");
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('|| hoverEl');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('picking');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('pointerup');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('pointercancel');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('setPointerCapture');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('freeze-request');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('pendingCommit');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('showActions');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('cropCard');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('inChrome');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('actions.contains');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('cropDrag');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('dataset.handle');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('crop.y + crop.height + 10');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('annotated');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('composeImage');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('showFrozen');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('hoverTag');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('Esc');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('raw.left - 48');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain('120 - (right - left)');
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).not.toContain('data-enso');
    expect(PAGE_DESIGN_MODE_HIDE_SCRIPT).toContain('hide');
    expect(PAGE_DESIGN_MODE_DISABLE_SCRIPT).toContain('setEnabled(false)');
  });

  it('enable script is valid JavaScript', () => {
    expect(() => new Function(PAGE_DESIGN_MODE_ENABLE_SCRIPT)).not.toThrow();
  });

  it('clips freeze overlay and locks replaced-element boxes so guest layout cannot grow', () => {
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain("overflow: 'hidden'");
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain("contain: 'strict'");
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain("setProperty('width'");
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain("setProperty('height'");
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain("'important'");
  });

  it('hides freeze layer before host screenshot so the shot is the live viewport, not overlay chrome', () => {
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain("freezeLayer.style.visibility = 'hidden'");
    expect(PAGE_DESIGN_MODE_ENABLE_SCRIPT).toContain("freezeLayer.style.visibility = ''");
    expect(PAGE_DESIGN_MODE_HIDE_SCRIPT).toContain('hide');
  });

  it('exports valid Cursor component probe and full design runtime scripts', () => {
    expect(() => new Function(PAGE_COMPONENT_PROBE_SCRIPT)).not.toThrow();
    expect(PAGE_COMPONENT_PROBE_SCRIPT).toContain('molten-picker-component-query');
    expect(PAGE_COMPONENT_PROBE_SCRIPT).toContain('__reactFiber$');
    expect(PAGE_COMPONENT_PROBE_SCRIPT).toContain('__vueParentComponent');
    expect(PAGE_COMPONENT_PROBE_SCRIPT).toContain('__svelte_meta');

    expect(() => new Function(PAGE_DESIGN_RUNTIME_SCRIPT)).not.toThrow();
    expect(PAGE_DESIGN_RUNTIME_SCRIPT).toContain('MOLTEN-GLASS-OVERLAY');
    expect(PAGE_DESIGN_RUNTIME_SCRIPT).toContain('designStart');
    expect(PAGE_DESIGN_RUNTIME_SCRIPT).toContain('designStop');
    expect(PAGE_DESIGN_RUNTIME_SCRIPT).toContain('designDescribe');
    expect(PAGE_DESIGN_RUNTIME_SCRIPT).toContain('designRegionAnchor');
    expect(PAGE_DESIGN_RUNTIME_SCRIPT).toContain('designPins');
    expect(PAGE_DESIGN_RUNTIME_SCRIPT).toContain('designPinOpen');
    expect(PAGE_DESIGN_RUNTIME_SCRIPT).toContain('previewCss');
    expect(PAGE_DESIGN_RUNTIME_SCRIPT).toContain('readCss');
    expect(PAGE_DESIGN_RUNTIME_SCRIPT).toContain('scroll to nearest');

    const callSrc = pageDesignRuntimeCallScript('designMove', ['parent']);
    expect(() => new Function(callSrc)).not.toThrow();
    expect(callSrc).toContain('designMove');
  });
});

describe('compact snapshot script', () => {
  it('is valid JavaScript', () => {
    expect(() => new Function(PAGE_SNAPSHOT_SCRIPT)).not.toThrow();
  });

  it('only keeps viewport-visible interactive controls and visible text', () => {
    expect(PAGE_SNAPSHOT_SCRIPT).toContain('innerHeight');
    expect(PAGE_SNAPSHOT_SCRIPT).toContain('innerWidth');
    expect(PAGE_SNAPSHOT_SCRIPT).toMatch(/checkVisibility|getBoundingClientRect/);
    expect(PAGE_SNAPSHOT_SCRIPT).toContain("return 'click'");
    expect(PAGE_SNAPSHOT_SCRIPT).toContain("return 'fill'");
    expect(PAGE_SNAPSHOT_SCRIPT).toContain("return 'select'");
    expect(PAGE_SNAPSHOT_SCRIPT).toContain("type === 'file'");
    expect(PAGE_SNAPSHOT_SCRIPT).toContain("type === 'hidden'");
    expect(PAGE_SNAPSHOT_SCRIPT).toContain('TreeWalker');
    expect(PAGE_SNAPSHOT_SCRIPT).not.toContain('LANDMARK');
  });

  it('includes password fields as fillable controls but never snapshots the value', () => {
    expect(PAGE_SNAPSHOT_SCRIPT).not.toContain("type === 'password' || type === 'file'");
    expect(PAGE_SNAPSHOT_SCRIPT).toContain("el.type !== 'password'");
    expect(PAGE_SNAPSHOT_SCRIPT).toContain("type === 'file'");
  });
});

describe('pre-action hittable guard', () => {
  it('click and type reject covered targets instead of firing into an overlay', () => {
    const click = pageClickScript('e3');
    const type = pageTypeScript('e3', 'hi', false);
    for (const src of [click, type]) {
      expect(src).toContain('elementFromPoint');
      expect(src).toContain('enso-browser-lock-overlay');
      expect(src).toContain("'covered'");
      expect(src).toContain('isConnected');
    }
  });
});

describe('post-action settle', () => {
  it('waits two frames or 50ms after click-like actions, and up to 200ms after combobox typing', () => {
    expect(PAGE_SETTLE_FRAME_MS).toBe(50);
    expect(PAGE_SETTLE_COMBOBOX_MS).toBe(200);
    const click = pageClickScript('e1');
    expect(click).toContain('requestAnimationFrame');
    expect(click).toContain(String(PAGE_SETTLE_FRAME_MS));
    expect(click).not.toContain(String(PAGE_SETTLE_COMBOBOX_MS));
    const type = pageTypeScript('e1', 'zurich', false);
    expect(type).toContain('requestAnimationFrame');
    expect(type).toContain(String(PAGE_SETTLE_COMBOBOX_MS));
    expect(pageSelectOptionScript('e1', ['US'])).toContain('requestAnimationFrame');
    expect(pageClickXyScript(10, 20)).toContain('requestAnimationFrame');
    expect(pagePressKeyScript('Enter')).toContain('requestAnimationFrame');
    expect(pageScrollScript({ direction: 'down' })).toContain('requestAnimationFrame');
  });
});

describe('drag point resolver', () => {
  it('resolves source/target in page space and hides the lock overlay so hit-testing is real', () => {
    const src = pageDragPointsScript({ ref: 'e1' }, { x: 2, y: 3 });
    expect(src).toContain('elementFromPoint');
    expect(src).toContain('data-enso-ref');
    expect(src).not.toContain('MouseEvent');
    expect(pageLockOverlayDisplayScript(true)).toContain('enso-browser-lock-overlay');
    expect(pageLockOverlayDisplayScript(true)).toContain('none');
  });

  it('fires a shared DataTransfer HTML5 drag sequence so native drop handlers run', () => {
    const src = pageDragPointsScript({ ref: 'e1' }, { ref: 'e2' });
    expect(src).toContain('DataTransfer');
    expect(src).toContain('DragEvent');
    expect(src).toContain("'dragstart'");
    expect(src).toContain("'dragover'");
    expect(src).toContain("'drop'");
    expect(src).toContain("'dragend'");
  });
});
