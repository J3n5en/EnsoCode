import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IS_MAC } from '@/lib/keybindings';
import { useDesignAnnotationsStore } from '@/stores/designAnnotations';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      key.replace(/\{\{(\w+)\}\}/g, (token, name: string) => String(params?.[name] ?? token)),
  }),
}));

import {
  ANNOTATE_SHORTCUT_LABEL,
  AnnotateToolbarControl,
  BrowserAnnotateStageOverlay,
  DesignFrameRing,
  DesignHintBar,
  useBrowserAnnotateSession,
} from './BrowserAnnotateOverlay';

describe('BrowserAnnotateOverlay components', () => {
  beforeEach(() => {
    useDesignAnnotationsStore.getState().resetForTests();
  });

  it('renders DesignHintBar with phase-appropriate hint and 4 markup tools', () => {
    const idleHtml = renderToStaticMarkup(
      <DesignHintBar
        drawing={false}
        pick={null}
        markupTool={null}
        editorOpen={false}
        onMarkupToolChange={vi.fn()}
        onExit={vi.fn()}
      />
    );
    expect(idleHtml).toContain('data-component="design-hint-row"');
    expect(idleHtml).toContain('Click');
    expect(idleHtml).toContain('to create an area');
    expect(idleHtml).toContain('aria-label="Screenshot markup tools"');
    expect(idleHtml).toContain('aria-label="Draw"');
    expect(idleHtml).toContain('aria-label="Ellipse"');
    expect(idleHtml).toContain('aria-label="Rectangle"');
    expect(idleHtml).toContain('aria-label="Arrow"');

    const markupHtml = renderToStaticMarkup(
      <DesignHintBar
        drawing={false}
        pick={{
          elements: [],
          region: { left: 10, top: 10, width: 100, height: 80 },
          viewportWidth: 800,
          description: { elements: [], image: null },
          markup: [],
          redoMarkup: [],
        }}
        markupTool="pen"
        editorOpen={false}
        onMarkupToolChange={vi.fn()}
        onExit={vi.fn()}
      />
    );
    expect(markupHtml).toContain('to undo');
    expect(markupHtml).toContain('to stop');
  });

  it('renders AnnotateToolbarControl across familiarity tiers and queue dropdown', () => {
    const neverHtml = renderToStaticMarkup(
      <AnnotateToolbarControl
        tabId="tab-1"
        conversationId="conv-1"
        active={false}
        disabled={false}
        queueOpen={false}
        onQueueOpenChange={vi.fn()}
        onToggleDesignMode={vi.fn()}
        onOpenPinFromQueue={vi.fn()}
        onSendQueue={vi.fn()}
      />
    );
    expect(neverHtml).toContain('Annotate');
    expect(neverHtml).toContain('M14.434 6.765');
    expect(neverHtml).toContain('data-gradient-sweep=""');
    expect(ANNOTATE_SHORTCUT_LABEL).toMatch(/D$/);

    useDesignAnnotationsStore.getState().addAnnotation('conv-1', {
      id: 'ann-1',
      kind: 'element',
      comment: 'Make button primary blue',
      browserId: 'tab-1',
      pageKey: 'http://localhost:3000/',
      images: [],
      elements: [
        {
          tagName: 'BUTTON',
          id: 'cta',
          uniqueId: 'u-1',
          className: 'btn',
          innerText: 'Continue',
          path: 'main > button#cta',
          attributes: [],
          rect: { top: 20, left: 40, width: 100, height: 36 },
          styles: {
            color: '#fff',
            backgroundColor: '#000',
            fontSize: '14px',
            fontFamily: 'sans-serif',
            display: 'inline-flex',
            position: 'relative',
          },
          component: 'CtaButton',
        },
      ],
    });

    const queueHtml = renderToStaticMarkup(
      <AnnotateToolbarControl
        tabId="tab-1"
        conversationId="conv-1"
        active={true}
        disabled={false}
        queueOpen={true}
        onQueueOpenChange={vi.fn()}
        onToggleDesignMode={vi.fn()}
        onOpenPinFromQueue={vi.fn()}
        onSendQueue={vi.fn()}
      />
    );
    expect(queueHtml).toContain('Send');
    expect(queueHtml).toContain('1 edit');
    expect(queueHtml).toContain('Clear All');
    expect(queueHtml).toContain('Make button primary blue');
  });

  it('renders BrowserAnnotateStageOverlay with floating note card, Batch edits toggle, and region SVG canvas', () => {
    const overlayHtml = renderToStaticMarkup(
      <BrowserAnnotateStageOverlay
        tabId="tab-1"
        conversationId="conv-1"
        stageSize={{ width: 800, height: 600 }}
        draftPick={{
          elements: [],
          region: { left: 50, top: 60, width: 240, height: 140 },
          viewportWidth: 800,
          description: { elements: [], image: null },
          markup: [
            {
              kind: 'arrow',
              from: { x: 10, y: 10 },
              to: { x: 100, y: 80 },
            },
          ],
          redoMarkup: [],
        }}
        openPin={null}
        markupTool="arrow"
        warningShown={true}
        onWarningShownChange={vi.fn()}
        onDraftPickChange={vi.fn()}
        onMoveSelection={vi.fn()}
        onCancelDraft={vi.fn()}
        onCloseOpenPin={vi.fn()}
        onSendQueue={vi.fn()}
        onStrokeStateChange={vi.fn()}
        active
      />
    );
    expect(overlayHtml).toContain('Region 240 × 140');
    expect(overlayHtml).toContain('aria-label="Draw on screenshot region"');
    expect(overlayHtml).toContain('data-design-markup-stroke=""');
    expect(overlayHtml).toContain('Batch edits');
    expect(overlayHtml).toContain('Send note');
    expect(overlayHtml).toContain('Discard comment?');
    expect(overlayHtml).toContain('Keep Editing');

    const ringHtml = renderToStaticMarkup(<DesignFrameRing active={true} />);
    expect(ringHtml).toContain('data-component="design-frame-ring"');
  });
});

describe('Annotate 全局快捷键只交给屏幕上的浏览器', () => {
  const browser = {
    setDesignMode: vi.fn(),
    onDesignMode: vi.fn(() => () => {}),
    setAnnotationPins: vi.fn(),
    clearSelection: vi.fn(),
    openAnnotationPin: vi.fn(),
    previewDesignCss: vi.fn(),
  };
  const noop = () => {};
  let root: Root;

  /** mod = 本平台主修饰键（mac ⌘ / 其它 Ctrl） */
  const keydown = (key: string, init: { mod?: boolean; shift?: boolean } = {}) =>
    Object.assign(new window.Event('keydown', { bubbles: true, cancelable: true }), {
      key,
      metaKey: Boolean(init.mod) && IS_MAC,
      ctrlKey: Boolean(init.mod) && !IS_MAC,
      shiftKey: Boolean(init.shift),
      altKey: false,
    });

  function Session(props: { tabId: string; active: boolean; designMode?: boolean }) {
    useBrowserAnnotateSession({
      tabId: props.tabId,
      conversationId: 'conv-1',
      url: 'http://localhost:3000/',
      designMode: props.designMode ?? false,
      onDesignModeState: noop,
      active: props.active,
    });
    return null;
  }

  function Stage(props: {
    tabId: string;
    active: boolean;
    onDraftPickChange: (next: unknown) => void;
  }) {
    return (
      <BrowserAnnotateStageOverlay
        tabId={props.tabId}
        conversationId="conv-1"
        stageSize={{ width: 800, height: 600 }}
        draftPick={{
          elements: [],
          region: { left: 10, top: 10, width: 120, height: 80 },
          viewportWidth: 800,
          description: { elements: [], image: null },
          markup: [{ kind: 'arrow', from: { x: 1, y: 1 }, to: { x: 20, y: 20 } }],
          redoMarkup: [],
        }}
        openPin={null}
        markupTool={null}
        warningShown={false}
        onWarningShownChange={noop}
        onDraftPickChange={props.onDraftPickChange}
        onMoveSelection={noop}
        onCancelDraft={noop}
        onCloseOpenPin={noop}
        onSendQueue={noop}
        onStrokeStateChange={noop}
        active={props.active}
      />
    );
  }

  beforeEach(() => {
    const dom = parseHTML(
      '<html><body><div id="root"></div><div role="dialog"><button type="button">OK</button></div></body></html>'
    );
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useDesignAnnotationsStore.getState().resetForTests();
    for (const fn of Object.values(browser)) fn.mockClear();
    browser.setDesignMode.mockResolvedValue({});
    Object.assign(dom.window, { electronAPI: { browser } });
    root = createRoot(dom.document.getElementById('root') as unknown as HTMLElement);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  // 真实场景：开着两个浏览器 tab，按一次 ⌘⇧D 两个都切换了设计模式
  it('⌘⇧D 只切换屏幕上那个浏览器的设计模式', async () => {
    await act(async () =>
      root.render(
        <>
          <Session tabId="tab-a" active={false} />
          <Session tabId="tab-b" active />
        </>
      )
    );
    await act(async () => {
      window.dispatchEvent(keydown('D', { mod: true, shift: true }));
    });
    expect(browser.setDesignMode).toHaveBeenCalledTimes(1);
    expect(browser.setDesignMode).toHaveBeenCalledWith('tab-b', true);
  });

  // 真实场景：A 会话浏览器开着设计模式，切到 B 后，B 弹窗里的 Esc 在捕获阶段被 A 截走、弹窗关不掉
  it('隐藏的浏览器开着设计模式时，不截走别处的 Esc', async () => {
    await act(async () => root.render(<Session tabId="tab-a" active={false} designMode />));
    const event = keydown('Escape');
    await act(async () => {
      document.querySelector('[role="dialog"] button')?.dispatchEvent(event);
    });
    // 截走 = preventDefault + stopPropagation，B 的弹窗就收不到这次 Esc
    expect(event.defaultPrevented).toBe(false);
    expect(event.cancelBubble).toBe(false);
    expect(browser.setDesignMode).not.toHaveBeenCalled();
  });

  // 真实场景：隐藏的 tab 留着区域草稿，在别处按 ⌘Z 被拦去撤销那份看不见的草稿
  it('⌘Z 只撤销屏幕上那个浏览器的区域草稿', async () => {
    const hidden = vi.fn();
    const shown = vi.fn();
    await act(async () =>
      root.render(
        <>
          <Stage tabId="tab-a" active={false} onDraftPickChange={hidden} />
          <Stage tabId="tab-b" active onDraftPickChange={shown} />
        </>
      )
    );
    await act(async () => {
      window.dispatchEvent(keydown('z', { mod: true }));
    });
    expect(hidden).not.toHaveBeenCalled();
    expect(shown).toHaveBeenCalledTimes(1);
  });
});
