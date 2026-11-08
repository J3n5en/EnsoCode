import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_CANVAS_PALETTE,
  annotateFamiliarityOf,
  annotationPinSpecOf,
  appendSignificantMark,
  type BrowserElementSnapshot,
  beginRegionDrag,
  buildAnnotationsPrompt,
  clampRegionToViewport,
  createAnnotationQueueReducer,
  createCssStage,
  DESIGN_CSS_PROPERTIES,
  DESIGN_MODE_HUES,
  type DesignAnnotation,
  describeCssStage,
  designAnnotationPinsFor,
  designModePageKey,
  elementCropBounds,
  elementLabelOf,
  elementSummaryLabelOf,
  finishMarquee,
  formatBrowserElementBlock,
  formatCssEditsSummary,
  frameRingPaths,
  getFreehandStroke,
  isCssPropertyShown,
  isValidElementSnapshot,
  mergeCommentCssBlock,
  ownsMarkupUndo,
  parseBrowserElementSnapshot,
  parseCssEditsComment,
  parsePersistedAnnotations,
  pinGeometry,
  placeFloatingNoteCard,
  placePinEditor,
  queuedCssEditsOf,
  reduceCssStage,
  reduceMarquee,
  regionHandleAt,
  regionHandleCursor,
  resolveDesignEscapeAction,
  resolveDesignHintPhase,
  resolveNoteSubmitAction,
  serializePersistedAnnotations,
  shapePaths,
  snapMarkupPoint,
  splitCommentCssBlock,
  stepCssValue,
  stepRegionDrag,
  stripBrowserElementBlocks,
  svgPathFromStroke,
  translateRegionMarkup,
} from './designAnnotation';

const makeElement = (overrides: Partial<BrowserElementSnapshot> = {}): BrowserElementSnapshot => ({
  tagName: 'BUTTON',
  id: 'submit-btn',
  uniqueId: 'cursor-el-abc12-1',
  className: 'btn primary',
  innerText: 'Save changes',
  path: 'main > form > button#submit-btn',
  attributes: [
    { name: 'id', value: 'submit-btn' },
    { name: 'class', value: 'btn primary' },
    { name: 'data-cursor-css-target', value: 'tok' },
  ],
  rect: { top: 100, left: 200, width: 120, height: 40 },
  styles: {
    color: 'rgb(255, 255, 255)',
    backgroundColor: 'rgb(58, 150, 221)',
    fontSize: '14px',
    fontFamily: 'Inter, sans-serif',
    display: 'inline-flex',
    position: 'relative',
  },
  component: 'SubmitButton',
  componentStack: ['App', 'SettingsForm', 'SubmitButton'],
  framework: 'react',
  hueIndex: 0,
  ...overrides,
});

describe('hues and element snapshots', () => {
  it('defines 8 Cursor hues and canvas palette', () => {
    expect(DESIGN_MODE_HUES).toHaveLength(8);
    expect(DESIGN_MODE_HUES.map((h) => h.name)).toEqual([
      'blue',
      'purple',
      'green',
      'orange',
      'cyan',
      'magenta',
      'red',
      'yellow',
    ]);
    expect(ANNOTATION_CANVAS_PALETTE[0]).toEqual({
      fill: 'rgba(58, 150, 221, 0.04)',
      stroke: 'rgba(58, 150, 221, 0.5)',
      scribbleStroke: 'rgba(58, 150, 221, 0.92)',
    });
  });

  it('validates and parses BrowserElementSnapshot with strict bounds', () => {
    const el = makeElement();
    expect(isValidElementSnapshot(el)).toBe(true);
    expect(parseBrowserElementSnapshot(el)).toEqual(el);
    expect(isValidElementSnapshot({ ...el, tagName: 'X'.repeat(129) })).toBe(false);
    expect(
      isValidElementSnapshot({ ...el, rect: { top: 0, left: 0, width: -1, height: 10 } })
    ).toBe(false);
    expect(isValidElementSnapshot({ ...el, framework: 'angular' })).toBe(false);
    expect(parseBrowserElementSnapshot(null)).toBeNull();
  });

  it('formats labels and fenced browser_element blocks without data-cursor-* attributes', () => {
    const el = makeElement();
    expect(elementLabelOf(el)).toBe('SubmitButton');
    expect(elementSummaryLabelOf(el)).toBe('SubmitButton · button "Save changes"');
    const block = formatBrowserElementBlock(el);
    expect(block).toContain('```browser_element');
    expect(block).toContain('The user selected this node in the browser preview.');
    expect(block).toContain('tag: button');
    expect(block).toContain('dom_path: main > form > button#submit-btn');
    expect(block).toContain('id: submit-btn');
    expect(block).toContain('class: btn primary');
    expect(block).toContain('visible_text: Save changes');
    expect(block).toContain('bounds_css_px: top=100 left=200 width=120 height=40');
    expect(block).toContain('framework: react');
    expect(block).toContain('component: SubmitButton');
    expect(block).toContain('component_stack: App > SettingsForm > SubmitButton');
    expect(block).toContain('  id=submit-btn');
    expect(block).not.toContain('data-cursor-css-target');
  });

  it('computes elementCropBounds with 48px padding and 120px minimum', () => {
    const crop = elementCropBounds([makeElement()], 1, { width: 1000, height: 800 });
    expect(crop).toEqual({ x: 152, y: 52, width: 216, height: 136 });
  });
});

describe('designModePageKey and pin filtering', () => {
  it('strips normal hashes but preserves hash-router paths up to secondary hash', () => {
    expect(designModePageKey('http://localhost:3000/dashboard#section-2')).toBe(
      'http://localhost:3000/dashboard'
    );
    expect(designModePageKey('http://localhost:3000/#/settings/profile#anchor')).toBe(
      'http://localhost:3000/#/settings/profile'
    );
    expect(designModePageKey('http://localhost:3000/#!/ billing')).toBe(
      'http://localhost:3000/#!/%20billing'
    );
  });

  it('converts annotations to pin specs and filters by pageKey', () => {
    const el = makeElement();
    const item: DesignAnnotation = {
      id: 'ann-1',
      kind: 'region',
      number: 1,
      comment: 'Fix alignment',
      browserId: 'tab-1',
      pageKey: 'http://localhost:3000/app',
      images: [],
      region: {
        rect: { top: 120, left: 210, width: 160, height: 90 },
        anchor: el,
        markup: [{ kind: 'rect', from: { x: 10, y: 10 }, to: { x: 50, y: 40 } }],
      },
    };
    const pin = annotationPinSpecOf(item);
    expect(pin).toEqual({
      id: 'ann-1',
      number: 1,
      comment: 'Fix alignment',
      label: 'SubmitButton · button "Save changes"',
      elements: [
        {
          uid: 'cursor-el-abc12-1',
          tagName: 'BUTTON',
          id: 'submit-btn',
          className: 'btn primary',
          innerText: 'Save changes',
        },
      ],
      region: {
        left: 10,
        top: 20,
        width: 160,
        height: 90,
      },
    });
    expect(
      designAnnotationPinsFor('http://localhost:3000/app#top', {
        pageKey: 'http://localhost:3000/app',
        pins: [pin],
      })
    ).toEqual([pin]);
    expect(
      designAnnotationPinsFor('http://localhost:3000/other', {
        pageKey: 'http://localhost:3000/app',
        pins: [pin],
      })
    ).toEqual([]);
  });
});

describe('annotation queue reducer and persistence', () => {
  const reducer = createAnnotationQueueReducer((item) => item.pageKey);
  const el = makeElement();

  it('assigns sequential numbers per browserId + pageKey and supports update/remove/restore/append/clear', () => {
    const empty = { items: [] as DesignAnnotation[] };
    const d1 = {
      id: 'a1',
      kind: 'element' as const,
      comment: 'first',
      browserId: 'tab-1',
      pageKey: 'http://localhost:3000/a',
      images: [],
      elements: [el],
    };
    const d2 = {
      ...d1,
      id: 'a2',
      comment: 'second same page',
    };
    const d3 = {
      ...d1,
      id: 'a3',
      pageKey: 'http://localhost:3000/b',
      comment: 'first on page b',
    };
    let state = reducer(empty, { type: 'add', draft: d1 });
    state = reducer(state, { type: 'add', draft: d2 });
    state = reducer(state, { type: 'add', draft: d3 });
    expect(state.items.map((i) => [i.id, i.number])).toEqual([
      ['a1', 1],
      ['a2', 2],
      ['a3', 1],
    ]);

    state = reducer(state, { type: 'update', id: 'a2', comment: 'updated second' });
    expect(state.items[1]?.comment).toBe('updated second');

    const removed = state.items[0]!;
    state = reducer(state, { type: 'remove', ids: ['a1'] });
    expect(state.items.map((i) => i.id)).toEqual(['a2', 'a3']);

    // Restore puts a1 back and renumbers subsequent items on same pageKey
    state = reducer(state, { type: 'restore', items: [removed] });
    expect(state.items.map((i) => [i.id, i.number])).toEqual([
      ['a1', 1],
      ['a2', 2],
      ['a3', 1],
    ]);

    // Round-trip persistence strips images and validates schema v1
    const raw = serializePersistedAnnotations({
      queues: new Map([['conv-1', state]]),
      pages: new Map([['tab-1', 'http://localhost:3000/a']]),
    });
    const hydrated = parsePersistedAnnotations(raw);
    expect(hydrated.pages.get('tab-1')).toBe('http://localhost:3000/a');
    expect(hydrated.queues.get('conv-1')?.items).toHaveLength(3);
    expect(hydrated.queues.get('conv-1')?.items[0]?.images).toEqual([]);
  });
});

describe('marquee state machine and 8-way region resize', () => {
  it('handles click vs drag threshold, Shift axis lock, Alt center, Space pan, and Escape cancel', () => {
    const initial = {
      kind: 'pressed' as const,
      origin: { x: 100, y: 100 },
      pointer: { x: 100, y: 100 },
      keys: { alt: false, shiftDown: false, shiftArmed: false, space: false },
    };
    const tiny = reduceMarquee(initial, {
      type: 'move',
      point: { x: 103, y: 102 },
      shiftKey: false,
      altKey: false,
    });
    expect(tiny.kind).toBe('pressed');
    expect(
      finishMarquee(
        tiny,
        { type: 'move', point: { x: 103, y: 102 }, shiftKey: false, altKey: false },
        { width: 800, height: 600 }
      )
    ).toEqual({ kind: 'click' });

    // Drag then press Shift to lock axis (horizontal move locks height to frozen 30)
    let drag = reduceMarquee(initial, {
      type: 'move',
      point: { x: 160, y: 130 },
      shiftKey: false,
      altKey: false,
    });
    drag = reduceMarquee(drag, { type: 'key', key: 'Shift', down: true });
    drag = reduceMarquee(drag, {
      type: 'move',
      point: { x: 180, y: 145 },
      shiftKey: true,
      altKey: false,
    });
    expect(drag.kind).toBe('dragging');
    if (drag.kind === 'dragging') {
      expect(drag.rect.width).toBe(80);
      expect(drag.rect.height).toBe(30);
    }

    // Hold Space to pan the marquee
    drag = reduceMarquee(drag, { type: 'key', key: 'Space', down: true });
    drag = reduceMarquee(drag, {
      type: 'move',
      point: { x: 200, y: 165 },
      shiftKey: true,
      altKey: false,
    });
    if (drag.kind === 'dragging') {
      expect(drag.rect).toEqual({ x: 120, y: 120, width: 80, height: 30 });
    }

    // Escape cancels
    const cancelled = reduceMarquee(drag, { type: 'key', key: 'Escape', down: true });
    expect(cancelled.kind).toBe('cancelled');
  });

  it('detects 8 resize handles + move and resizes with Shift/Alt/Space modifiers', () => {
    const rect = { left: 100, top: 100, width: 200, height: 100 };
    expect(regionHandleAt({ x: 2, y: 2 }, rect)).toBe('nw');
    expect(regionHandleAt({ x: 198, y: 98 }, rect)).toBe('se');
    expect(regionHandleAt({ x: 100, y: 2 }, rect)).toBe('n');
    expect(regionHandleAt({ x: 100, y: 50 }, rect)).toBe('move');
    expect(regionHandleCursor('move', false)).toBe('grab');
    expect(regionHandleCursor('move', true)).toBe('grabbing');
    expect(regionHandleCursor('nw', false)).toBe('nwse-resize');

    const bounds = { left: 0, top: 0, width: 800, height: 600 };
    let state = beginRegionDrag({
      handle: 'se',
      point: { x: 300, y: 200 },
      rect,
      modifiers: { altKey: false, shiftKey: true },
    });
    state = stepRegionDrag(
      state,
      { type: 'move', point: { x: 340, y: 210 }, altKey: false, shiftKey: true },
      bounds
    );
    // Aspect ratio 2:1 preserved when Shift is held
    expect(state.rect).toEqual({ left: 100, top: 100, width: 240, height: 120 });

    // Translate markup when region moves
    const movedMarkup = translateRegionMarkup({
      markup: [{ kind: 'rect', from: { x: 20, y: 20 }, to: { x: 60, y: 50 } }],
      from: rect,
      to: { left: 110, top: 120, width: 200, height: 100 },
      markupScale: 1,
    });
    expect(movedMarkup).toEqual([{ kind: 'rect', from: { x: 10, y: 0 }, to: { x: 50, y: 30 } }]);
    expect(
      clampRegionToViewport({
        rect: { left: -10, top: -10, width: 4, height: 4 },
        viewport: { width: 500, height: 400 },
      }).width
    ).toBeGreaterThanOrEqual(12);
  });
});

describe('freehand stroke and vector markup shapes', () => {
  it('generates smooth perfect-freehand stroke paths and shape SVG paths', () => {
    const pts = [
      { x: 10, y: 10 },
      { x: 30, y: 20 },
      { x: 60, y: 45 },
      { x: 90, y: 50 },
    ];
    const stroke = getFreehandStroke(pts);
    expect(stroke.length).toBeGreaterThan(4);
    const d = svgPathFromStroke(stroke);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);

    const penPaths = shapePaths({ kind: 'pen', points: pts });
    expect(penPaths).toHaveLength(1);
    expect(penPaths[0]?.paint).toBe('fill');

    const arrowPaths = shapePaths({ kind: 'arrow', from: { x: 10, y: 10 }, to: { x: 110, y: 10 } });
    expect(arrowPaths).toHaveLength(2);
    expect(arrowPaths[0]?.paint).toBe('stroke');
    expect(arrowPaths[1]?.paint).toBe('fill');

    const snappedArrow = snapMarkupPoint({
      kind: 'arrow',
      from: { x: 0, y: 0 },
      to: { x: 100, y: 95 },
    });
    expect(Math.round(snappedArrow.x)).toBe(Math.round(snappedArrow.y));

    expect(
      appendSignificantMark([], { kind: 'rect', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } })
    ).toEqual([]);
    expect(
      appendSignificantMark([], { kind: 'rect', from: { x: 0, y: 0 }, to: { x: 20, y: 20 } })
    ).toHaveLength(1);
    expect(ownsMarkupUndo({ markCount: 1, toolHeld: false, noteOwnsUndo: true })).toBe(false);
    expect(ownsMarkupUndo({ markCount: 1, toolHeld: true, noteOwnsUndo: true })).toBe(true);
  });
});

describe('pinGeometry and floating card placement', () => {
  const geom = pinGeometry();

  it('places badges, flips at right edge, detects offscreen edges, and avoids badge collisions for pills', () => {
    expect(geom.placePinBadge({ top: 50, left: 100, width: 80, height: 30 }, 500, 0)).toEqual({
      top: 50,
      left: 184,
      corner: 'top-left',
    });
    expect(geom.placePinBadge({ top: 50, left: 420, width: 70, height: 30 }, 500, 0)).toEqual({
      top: 50,
      left: 394,
      corner: 'top-right',
    });
    expect(geom.offscreenEdge({ top: -30, left: 100, width: 22, height: 22 }, 500, 400)).toBe(
      'top'
    );
    expect(
      geom.pillCenter(
        { top: -30, left: 200, width: 22, height: 22 },
        'top',
        2,
        [{ top: 8, left: 200, width: 22, height: 22 }],
        500,
        400
      )
    ).not.toBe(211);

    const pinPos = placePinEditor(
      { top: 100, left: 120, detached: false, rulerInset: 0 },
      { width: 800, height: 600 },
      { width: 320, height: 180 }
    );
    expect(pinPos).toEqual({ x: 120, y: 128 });

    const cardPos = placeFloatingNoteCard(
      { x: 100, y: 100, width: 200, height: 40 },
      { width: 800, height: 600 },
      320,
      180
    );
    expect(cardPos.y).toBe(148);
  });
});

describe('CSS properties catalog, scrubbing, staging, and comment merging', () => {
  it('exposes all 27 CSS properties and filters by shownFor', () => {
    expect(DESIGN_CSS_PROPERTIES).toHaveLength(27);
    const gapProp = DESIGN_CSS_PROPERTIES.find((p) => p.name === 'gap')!;
    expect(isCssPropertyShown(gapProp, { rendersText: false, values: { display: 'block' } })).toBe(
      false
    );
    expect(isCssPropertyShown(gapProp, { rendersText: false, values: { display: 'flex' } })).toBe(
      true
    );
  });

  it('steps length and preset values with ArrowUp/ArrowDown and Shift x10', () => {
    const fontSize = DESIGN_CSS_PROPERTIES.find((p) => p.name === 'font-size')!;
    expect(stepCssValue('16px', 1, false, fontSize)).toBe('17px');
    expect(stepCssValue('16px', 1, true, fontSize)).toBe('26px');
    expect(stepCssValue('1px', -1, false, fontSize)).toBeNull();

    const displayProp = DESIGN_CSS_PROPERTIES.find((p) => p.name === 'display')!;
    expect(stepCssValue('block', -1, false, displayProp)).toBe('inline-block');
  });

  it('stages CSS edits, disables/enables/resets properties, and round-trips CSS edits summary in comment', () => {
    const snapshot = {
      rendersText: true,
      values: { 'font-size': '14px', color: 'rgb(0, 0, 0)', display: 'flex' },
      authored: ['font-size'],
      variables: { colors: [], lengths: [] },
      rect: { top: 0, left: 0, width: 100, height: 30 },
    };
    let stage = createCssStage(snapshot, new Map());
    stage = reduceCssStage(stage, { kind: 'edit', property: 'font-size', value: '18px' }).staging;
    stage = reduceCssStage(stage, { kind: 'disable', property: 'color' }).staging;

    const desc = describeCssStage(stage);
    expect(desc.canReset).toBe(true);
    expect(desc.isDirty).toBe(true);

    const summary = formatCssEditsSummary(desc.changes);
    expect(summary).toBe('CSS edits — font-size: 14px → 18px; color: removed (was rgb(0, 0, 0))');

    const merged = mergeCommentCssBlock('Make the heading stand out', desc.changes);
    expect(merged).toBe(
      'Make the heading stand out\n\nCSS edits — font-size: 14px → 18px; color: removed (was rgb(0, 0, 0))'
    );

    const split = splitCommentCssBlock(merged);
    expect(split.prose).toBe('Make the heading stand out');
    expect(parseCssEditsComment(merged)).toEqual(
      new Map([
        ['font-size', { from: '14px', to: '18px' }],
        ['color', { from: 'rgb(0, 0, 0)', to: null }],
      ])
    );

    const el = makeElement();
    const queued = queuedCssEditsOf([
      {
        id: '1',
        kind: 'element',
        number: 1,
        comment: merged,
        browserId: 'tab-1',
        pageKey: 'http://localhost:3000',
        images: [],
        elements: [el],
      },
    ]);
    expect(queued[el.uniqueId]).toEqual({ 'font-size': '18px', color: null });
  });
});

describe('hint phase, escape hierarchy, familiarity, and prompt serialization', () => {
  it('resolves hint phase, escape priority, submit action, familiarity, and frame ring paths', () => {
    expect(
      resolveDesignHintPhase({
        drawing: false,
        pick: null,
        markupToolHeld: false,
        editorOpen: false,
      })
    ).toBe('idle');
    expect(
      resolveDesignHintPhase({
        drawing: true,
        pick: null,
        markupToolHeld: false,
        editorOpen: false,
      })
    ).toBe('region-drawing');
    expect(
      resolveDesignHintPhase({
        drawing: false,
        pick: { region: { left: 0, top: 0, width: 50, height: 50 } },
        markupToolHeld: true,
        editorOpen: true,
      })
    ).toBe('region-markup');

    expect(
      resolveDesignEscapeAction({
        queueOwnsEscape: false,
        targetOwnsEscape: false,
        targetIsInput: false,
        markupStrokeActive: true,
        markupToolHeld: true,
        warningShown: true,
        draftOpen: true,
        editorOpen: true,
      })
    ).toBe('cancel-stroke');
    expect(
      resolveDesignEscapeAction({
        queueOwnsEscape: false,
        targetOwnsEscape: false,
        targetIsInput: false,
        markupStrokeActive: false,
        markupToolHeld: true,
        warningShown: true,
        draftOpen: true,
        editorOpen: true,
      })
    ).toBe('put-down-tool');

    expect(resolveNoteSubmitAction({ sendImmediately: true, isOnStack: false })).toBe('send-note');
    expect(resolveNoteSubmitAction({ sendImmediately: false, isOnStack: false })).toBe(
      'add-to-stack'
    );
    expect(resolveNoteSubmitAction({ sendImmediately: false, isOnStack: true })).toBe('save-note');

    expect(annotateFamiliarityOf(false, 0)).toBe('never');
    expect(annotateFamiliarityOf(true, 0)).toBe('few');
    expect(annotateFamiliarityOf(true, 5)).toBe('few');
    expect(annotateFamiliarityOf(true, 6)).toBe('many');

    const ring = frameRingPaths(400, 300, {
      topLeft: 8,
      topRight: 8,
      bottomRight: 8,
      bottomLeft: 8,
    });
    expect(ring.right).toContain('M 200 1');
    expect(ring.left).toContain('M 200 1');
  });

  it('builds multi-page numbered prompts with ui-element refs and fenced browser_element blocks', () => {
    const el = makeElement();
    const items: DesignAnnotation[] = [
      {
        id: 'a1',
        kind: 'element',
        number: 1,
        comment: 'Change button color to green',
        browserId: 'tab-1',
        pageKey: 'http://localhost:3000/login',
        images: [{ id: 'img-1', data: 'AAA', mimeType: 'image/png', width: 120, height: 40 }],
        elements: [el],
      },
      {
        id: 'a2',
        kind: 'region',
        number: 1,
        comment: 'Align this card with the header',
        browserId: 'tab-2',
        pageKey: 'http://localhost:3000/dashboard',
        images: [{ id: 'img-2', data: 'BBB', mimeType: 'image/png', width: 300, height: 180 }],
        region: {
          rect: { left: 50, top: 60, width: 300, height: 180 },
          anchor: el,
          markup: [],
        },
      },
    ];
    const built = buildAnnotationsPrompt(items);
    expect(built.text).toContain('On http://localhost:3000/login:');
    expect(built.text).toContain('On http://localhost:3000/dashboard:');
    expect(built.text).toContain(
      '1. [Selected UI element "SubmitButton" — path: main > form > button#submit-btn; text: Save changes] Change button color to green'
    );
    expect(built.text).toContain(
      '2. [Selected UI element "Region 300 × 180" — path: main > form > button#submit-btn; text: Screenshot region 300 × 180] Align this card with the header'
    );
    expect(built.text).not.toContain('— “Screenshot region');
    expect(built.text).toContain('```browser_element');
    expect(built.text).toContain('browser_tab_id: tab-1');
    expect(built.text).toContain('page_url: http://localhost:3000/login');
    expect(built.text).toContain('browser_tabs(action="select", tabId="tab-1")');
    expect(built.text).toContain('browser_tab_id: tab-2');
    expect(built.text).toContain('page_url: http://localhost:3000/dashboard');
    expect(built.text).toContain('browser_tabs(action="select", tabId="tab-2")');
    expect(built.text).toContain('region_bounds_css_px: top=60 left=50 width=300 height=180');
    expect(built.images).toHaveLength(2);

    const visibleOnly = stripBrowserElementBlocks(built.text);
    expect(visibleOnly).not.toContain('```browser_element');
    expect(visibleOnly).not.toContain('browser_tab_id:');
    expect(visibleOnly).not.toContain('page_url:');
    expect(visibleOnly).not.toContain('The user selected this node in the browser preview.');
    expect(visibleOnly).toContain('Change button color to green');
    expect(visibleOnly).toContain('Align this card with the header');
  });
});
