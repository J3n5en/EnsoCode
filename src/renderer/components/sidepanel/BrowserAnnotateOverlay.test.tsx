import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
