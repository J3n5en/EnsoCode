import {
  ANNOTATION_CANVAS_PALETTE,
  annotationPinSpecOf,
  appendSampledPoint,
  appendSignificantMark,
  type BrowserElementSnapshot,
  type BrowserPickedElementRef,
  beginRegionDrag,
  buildAnnotationsPrompt,
  type CssStageState,
  clampRegionToViewport,
  createCssStage,
  DESIGN_CSS_PROPERTIES,
  type DesignAnnotation,
  type DesignAnnotationImage,
  type DesignCssSnapshot,
  type DesignTopLeftRect,
  describeCssStage,
  designHintsForPlatform,
  designModePageKey,
  elementIdentityLabelOf,
  elementLabelOf,
  elementSummaryLabelOf,
  formatBrowserElementBlock,
  frameRingPaths,
  isCssPropertyShown,
  mergeCommentCssBlock,
  NOTE_SUBMIT_LABELS,
  ownsMarkupUndo,
  PICKER_HUE_COLORS,
  placeFloatingNoteCard,
  placePinEditor,
  queuedCssEditsOf,
  REGION_MARKUP_COLOR,
  REGION_MARKUP_STROKE_WIDTH,
  REGION_MARKUP_TOOLS,
  type RegionDragState,
  type RegionMarkupShape,
  type RegionMarkupTool,
  type RegionResizeHandle,
  reduceCssStage,
  regionHandleAt,
  regionHandleCursor,
  resolveDesignEscapeAction,
  resolveDesignHintPhase,
  resolveNoteSubmitAction,
  shapePaths,
  snapMarkupPoint,
  splitCommentCssBlock,
  stepCssValue,
  stepRegionDrag,
  translateRegionMarkup,
} from '@shared/browser/designAnnotation';
import type {
  BrowserDesignModeEvent,
  BrowserDesignMoveDirection,
  BrowserOpenPinResult,
  BrowserSelectionDescription,
} from '@shared/types/browser';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  Circle,
  CornerLeftUp,
  ImagePlus,
  MessageSquarePlus,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  insertUiElementMention,
  requestFocusComposer,
  submitComposerPayload,
} from '@/components/chat/composerMentionBridge';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useDesignAnnotationsStore } from '@/stores/designAnnotations';

const IS_MAC =
  typeof navigator !== 'undefined' && navigator.platform
    ? navigator.platform.startsWith('Mac')
    : true;

export const ANNOTATE_SHORTCUT_LABEL = IS_MAC ? '⌘⇧D' : 'Ctrl+Shift+D';

export function WindowPointerArrowIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={cn('h-3.5 w-3.5 shrink-0', className)}
    >
      <path d="M14.434 6.765c.793 0 1.076 1.051.388 1.448l-3.593 2.074v4.15c0 .793-1.052 1.075-1.449.387L5.8 7.93c-.299-.517.075-1.164.672-1.164zM13 .875c1.174 0 2.125.951 2.125 2.125v1c0 .345-.28.625-.625.625s-.625-.28-.625-.625V3c0-.483-.392-.875-.875-.875H3c-.483 0-.875.392-.875.875v10c0 .483.392.875.875.875h3c.345 0 .625.28.625.625s-.28.625-.625.625H3C1.826 15.125.875 14.174.875 13V3C.875 1.826 1.826.875 3 .875zm-5.708 7.14 2.687 4.651v-2.565c0-.331.176-.638.462-.803l2.223-1.283z" />
    </svg>
  );
}

export async function burnMarkupIntoPngBase64(input: {
  base64: string;
  markup: readonly RegionMarkupShape[];
  cropWidth: number;
}): Promise<string> {
  if (input.markup.length === 0 || !input.base64) return input.base64;
  return new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, img.naturalWidth || img.width);
        canvas.height = Math.max(1, img.naturalHeight || img.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(input.base64);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const scale = canvas.width / Math.max(1, input.cropWidth);
        ctx.scale(scale, scale);
        ctx.fillStyle = REGION_MARKUP_COLOR;
        ctx.strokeStyle = REGION_MARKUP_COLOR;
        ctx.lineWidth = REGION_MARKUP_STROKE_WIDTH;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const shape of input.markup) {
          for (const seg of shapePaths(shape, 'complete')) {
            const path = new Path2D(seg.d);
            if (seg.paint === 'fill') ctx.fill(path);
            else ctx.stroke(path);
          }
        }
        const url = canvas.toDataURL('image/png');
        resolve(url.slice(url.indexOf(',') + 1));
      } catch {
        resolve(input.base64);
      }
    };
    img.onerror = () => resolve(input.base64);
    img.src = input.base64.startsWith('data:')
      ? input.base64
      : `data:image/png;base64,${input.base64}`;
  });
}

export interface DraftPickState {
  elements: BrowserPickedElementRef[];
  region: DesignTopLeftRect | null;
  viewportWidth: number;
  description: BrowserSelectionDescription;
  markup: RegionMarkupShape[];
  redoMarkup: RegionMarkupShape[];
}

export interface OpenPinState {
  id: string;
  badge: BrowserOpenPinResult;
}

/**
 * 舞台蓝色流光边框（进入/退出 Design Mode 时的 0.55s / 0.35s 描边动画）
 */
export function DesignFrameRing({ active }: { active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [trace, setTrace] = useState<'in' | 'out' | null>(null);
  const prevActive = useRef(active);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (prevActive.current !== active) {
      prevActive.current = active;
      setTrace(active ? 'in' : 'out');
    }
  }, [active]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const paths = useMemo(
    () =>
      size.width > 4 && size.height > 4
        ? frameRingPaths(size.width, size.height, {
            topLeft: 6,
            topRight: 6,
            bottomRight: 6,
            bottomLeft: 6,
          })
        : null,
    [size.width, size.height]
  );

  if (!trace && !active)
    return <div ref={containerRef} className="pointer-events-none absolute inset-0" />;

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      data-component="design-frame-ring"
      data-trace={trace ?? (active ? 'in' : 'out')}
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      {paths && (
        <svg
          width={size.width}
          height={size.height}
          aria-hidden="true"
          className="block h-full w-full overflow-visible"
          onAnimationEnd={() => {
            if (!active) setTrace(null);
          }}
        >
          <path
            d={paths.right}
            pathLength={1}
            fill="none"
            stroke="rgb(58, 150, 221)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              strokeDasharray: 1,
              strokeDashoffset: trace === 'out' ? 1 : 0,
              transition:
                trace === 'out'
                  ? 'stroke-dashoffset 350ms cubic-bezier(0.65, 0, 0.35, 1)'
                  : 'stroke-dashoffset 550ms cubic-bezier(0.65, 0, 0.35, 1)',
            }}
          />
          <path
            d={paths.left}
            pathLength={1}
            fill="none"
            stroke="rgb(58, 150, 221)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              strokeDasharray: 1,
              strokeDashoffset: trace === 'out' ? 1 : 0,
              transition:
                trace === 'out'
                  ? 'stroke-dashoffset 350ms cubic-bezier(0.65, 0, 0.35, 1)'
                  : 'stroke-dashoffset 550ms cubic-bezier(0.65, 0, 0.35, 1)',
            }}
          />
        </svg>
      )}
    </div>
  );
}

/**
 * 顶部引导与手绘工具栏（Cursor `lo` + `$a`）
 */
export function DesignHintBar({
  drawing,
  pick,
  markupTool,
  editorOpen,
  onMarkupToolChange,
  onExit,
}: {
  drawing: boolean;
  pick: DraftPickState | null;
  markupTool: RegionMarkupTool | null;
  editorOpen: boolean;
  onMarkupToolChange: (tool: RegionMarkupTool | null) => void;
  onExit: () => void;
}) {
  const phase = resolveDesignHintPhase({
    drawing,
    pick: pick ? { region: pick.region } : null,
    markupToolHeld: markupTool !== null,
    editorOpen,
  });
  const hintsMap = useMemo(() => designHintsForPlatform(IS_MAC), []);
  const currentHint = hintsMap[phase];

  const renderTokens = (tokens: ReturnType<typeof designHintsForPlatform>[typeof phase]) =>
    tokens.map((tok, idx) =>
      typeof tok === 'string' ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: static hint tokens
        <span key={idx}>{tok}</span>
      ) : (
        // biome-ignore lint/suspicious/noArrayIndexKey: static hint tokens
        <strong key={idx} className="font-semibold text-foreground">
          {tok.key}
        </strong>
      )
    );

  const toolIcon = (icon: (typeof REGION_MARKUP_TOOLS)[number]['icon']) => {
    switch (icon) {
      case 'pencil':
        return <Pencil className="h-3.5 w-3.5" />;
      case 'circle':
        return <Circle className="h-3.5 w-3.5" />;
      case 'square':
        return <Square className="h-3.5 w-3.5" />;
      case 'arrow-right-up':
        return <ArrowUpRight className="h-3.5 w-3.5" />;
    }
  };

  return (
    <div
      data-component="design-hint-row"
      style={{ backgroundColor: 'var(--background)' }}
      className="flex h-8 shrink-0 items-center justify-between gap-2 border-b px-2.5 text-xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onExit}
          aria-label="Exit design mode"
          title={`Exit Design Mode (${ANNOTATE_SHORTCUT_LABEL})`}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <span
          data-hint=""
          className="truncate text-[12px] text-muted-foreground transition-all duration-150"
        >
          {renderTokens(currentHint)}
        </span>
      </div>
      <div
        role="toolbar"
        aria-label="Screenshot markup tools"
        className="flex shrink-0 items-center gap-0.5 rounded-md border bg-background/90 p-0.5 shadow-2xs"
      >
        {REGION_MARKUP_TOOLS.map((item) => {
          const active = markupTool === item.tool;
          return (
            <button
              key={item.tool}
              type="button"
              aria-label={item.label}
              aria-pressed={active}
              title={item.label}
              onClick={() => onMarkupToolChange(active ? null : item.tool)}
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-sm transition-colors',
                active
                  ? 'bg-[#3a96dd] text-white'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {toolIcon(item.icon)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 工具栏 Annotate 按钮（支持 never/few/many 三档熟悉度 + Try Annotate 预览卡 + Send 队列胶囊与下拉菜单）
 */
export function AnnotateToolbarControl({
  tabId,
  conversationId,
  active,
  disabled,
  queueOpen,
  onQueueOpenChange,
  onToggleDesignMode,
  onOpenPinFromQueue,
  onSendQueue,
}: {
  tabId: string;
  conversationId: string;
  active: boolean;
  disabled: boolean;
  queueOpen: boolean;
  onQueueOpenChange: (open: boolean) => void;
  onToggleDesignMode: (next: boolean) => void;
  onOpenPinFromQueue: (annotation: DesignAnnotation) => void;
  onSendQueue: (subsetIds?: ReadonlySet<string>) => void;
}) {
  const { t } = useI18n();
  const familiarity = useDesignAnnotationsStore((s) => s.familiarity());
  const annotateHovered = useDesignAnnotationsStore((s) => s.annotateHovered);
  const markHovered = useDesignAnnotationsStore((s) => s.markHovered);
  const allNotes = useDesignAnnotationsStore((s) => s.annotationsFor(conversationId));
  const tabNotes = useDesignAnnotationsStore((s) => s.annotationsFor(conversationId, tabId));
  const removeAnnotations = useDesignAnnotationsStore((s) => s.removeAnnotations);
  const clearAnnotations = useDesignAnnotationsStore((s) => s.clearAnnotations);

  const [upsellOpen, setUpsellOpen] = useState(false);
  const notes = active ? allNotes : tabNotes;
  const count = notes.length;

  if (count === 0 && !active) {
    return (
      <div className="relative flex shrink-0 items-center">
        <button
          type="button"
          disabled={disabled}
          aria-label="Annotate"
          aria-pressed={active}
          title={`Annotate (${ANNOTATE_SHORTCUT_LABEL}) — Point at anything and tell the agent what to fix`}
          onPointerEnter={() => {
            markHovered();
            if (familiarity === 'never') setUpsellOpen(true);
          }}
          onPointerLeave={() => setUpsellOpen(false)}
          onClick={() => {
            setUpsellOpen(false);
            onToggleDesignMode(true);
          }}
          className={cn(
            'relative flex h-6 items-center justify-center gap-1 overflow-hidden rounded text-xs font-medium transition-colors disabled:opacity-40',
            familiarity === 'many'
              ? 'w-6 text-muted-foreground hover:bg-muted hover:text-foreground'
              : 'px-2 text-foreground hover:bg-muted',
            familiarity === 'never' && !annotateHovered && 'border border-sky-500/40 bg-sky-500/10'
          )}
        >
          <WindowPointerArrowIcon />
          {familiarity !== 'many' && <span>Annotate</span>}
          {familiarity === 'never' && !annotateHovered && !disabled && (
            <span
              aria-hidden="true"
              data-gradient-sweep=""
              className="pointer-events-none absolute inset-0 bg-linear-to-r from-transparent via-sky-400/20 to-transparent animate-pulse"
            />
          )}
        </button>
        {upsellOpen && !disabled && (
          <div
            data-enso-float=""
            role="tooltip"
            aria-label="Try Annotate"
            className="absolute top-full right-0 z-50 mt-1.5 w-64 rounded-lg border bg-popover p-3 text-popover-foreground shadow-xl"
          >
            <div className="mb-2 flex h-24 items-center justify-center rounded-md border border-sky-500/20 bg-sky-500/5">
              <div className="flex flex-col items-center gap-1 text-sky-500">
                <WindowPointerArrowIcon className="h-6 w-6" />
                <span className="rounded bg-sky-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  Click · Drag · Draw · Edit CSS
                </span>
              </div>
            </div>
            <h2 className="text-xs font-semibold">Try Annotate</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Point at anything on the page and tell the agent what to fix.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex shrink-0 items-center" data-design-annotation-queue="">
      {count > 0 ? (
        <div className="flex h-6 items-center overflow-hidden rounded-md border border-[#3a96dd]/40 bg-[#3a96dd] text-white shadow-2xs">
          <button
            type="button"
            onClick={() =>
              onSendQueue(active ? undefined : new Set(tabNotes.map((item) => item.id)))
            }
            title={t('Send annotations to chat')}
            className="flex h-full items-center gap-1 px-2 text-xs font-medium transition-opacity hover:opacity-90"
          >
            <span>Send</span>
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-white/20 px-1 text-[10px] font-semibold tabular-nums">
              {count}
            </span>
          </button>
          <button
            type="button"
            aria-label={`Open annotation queue (${count})`}
            aria-expanded={queueOpen}
            onClick={() => onQueueOpenChange(!queueOpen)}
            className="flex h-full items-center border-l border-white/20 px-1 transition-colors hover:bg-black/10"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onToggleDesignMode(false)}
          aria-label="Annotate"
          aria-pressed={active}
          title={`Exit Design Mode (${ANNOTATE_SHORTCUT_LABEL})`}
          className="flex h-6 items-center gap-1 rounded bg-[#3a96dd]/15 px-2 text-xs font-medium text-[#3a96dd]"
        >
          <WindowPointerArrowIcon />
          {familiarity !== 'many' && <span>Annotate</span>}
        </button>
      )}

      {queueOpen && count > 0 && (
        <div
          data-enso-float=""
          data-design-owns-escape=""
          className="absolute top-full right-0 z-50 mt-1.5 w-72 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl"
        >
          <div className="flex items-center justify-between border-b px-3 py-2 text-xs">
            <span className="font-medium text-muted-foreground">
              {count === 1 ? '1 edit' : `${count} edits`}
            </span>
            <button
              type="button"
              onClick={() => {
                clearAnnotations(conversationId, active ? undefined : tabId);
                onQueueOpenChange(false);
              }}
              className="text-[11px] text-muted-foreground transition-colors hover:text-destructive"
            >
              Clear All
            </button>
          </div>
          <div className="max-h-64 divide-y overflow-y-auto">
            {notes.map((item) => {
              const regionThumb =
                item.kind === 'region' && item.images[0]
                  ? `data:${item.images[0].mimeType};base64,${item.images[0].data}`
                  : null;
              const extraCount =
                item.kind === 'element' && item.elements.length > 1 ? item.elements.length - 1 : 0;
              const summaryText =
                item.comment.trim() ||
                (item.kind === 'element' && item.elements[0]
                  ? elementSummaryLabelOf(item.elements[0])
                  : item.kind === 'region'
                    ? `Screenshot region ${Math.round(item.region.rect.width)} × ${Math.round(item.region.rect.height)}`
                    : 'Annotation');
              return (
                <div
                  key={item.id}
                  className="group flex items-center gap-2 px-2.5 py-2 text-xs hover:bg-muted/60"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onQueueOpenChange(false);
                      onOpenPinFromQueue(item);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-t-full rounded-br-full rounded-bl-xs bg-[#3a96dd] text-[11px] font-semibold text-white tabular-nums">
                      {item.number}
                    </span>
                    {regionThumb && (
                      <img
                        src={regionThumb}
                        alt=""
                        className="h-5 w-7 shrink-0 rounded border object-cover"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{summaryText}</span>
                    {extraCount > 0 && (
                      <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                        +{extraCount}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label="Delete annotation"
                    onClick={() => removeAnnotations(conversationId, [item.id])}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 27 项 CSS 属性检查器（Cursor `wi` / `Ti`）
 */
function CssInspectorPanel({
  stage,
  pinned,
  onTogglePinned,
  onClose,
  onStageChange,
}: {
  stage: CssStageState;
  pinned: boolean;
  onTogglePinned: () => void;
  onClose: () => void;
  onStageChange: (next: CssStageState, filed: Record<string, string | null>) => void;
}) {
  const [filter, setFilter] = useState('');
  const desc = useMemo(() => describeCssStage(stage), [stage]);

  const effectiveValues = useMemo(() => {
    const values = { ...stage.baseline.values };
    for (const [k, v] of stage.edits) {
      if (v) values[k] = v;
    }
    return values;
  }, [stage.baseline.values, stage.edits]);

  const visibleSpecs = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return DESIGN_CSS_PROPERTIES.filter(
      (spec) =>
        isCssPropertyShown(spec, {
          rendersText: stage.baseline.rendersText,
          values: effectiveValues,
        }) && spec.name.includes(q)
    );
  }, [filter, stage.baseline.rendersText, effectiveValues]);

  const applyAction = (action: Parameters<typeof reduceCssStage>[1]) => {
    const res = reduceCssStage(stage, action);
    onStageChange(res.staging, res.filed);
  };

  return (
    <div className="flex flex-col border-t bg-background/95">
      <div className="flex items-center gap-1.5 border-b px-2.5 py-1.5">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter CSS properties..."
          className="min-w-0 flex-1 rounded border bg-muted/40 px-2 py-0.5 text-[11px] outline-none focus:border-ring"
        />
        {desc.canReset && (
          <button
            type="button"
            aria-label="Reset all CSS edits"
            title="Reset all CSS edits"
            onClick={() => applyAction({ kind: 'resetAll' })}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          aria-label="Pin CSS inspector"
          aria-pressed={pinned}
          title={pinned ? 'Unpin inspector' : 'Pin inspector to top right'}
          onClick={onTogglePinned}
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded transition-colors',
            pinned
              ? 'bg-[#3a96dd]/15 text-[#3a96dd]'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          )}
        >
          <Pin className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label="Close CSS inspector"
          onClick={onClose}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="max-h-52 divide-y overflow-y-auto px-2 py-1 text-[11px]">
        {visibleSpecs.map((spec) => {
          const editVal = stage.edits.get(spec.name);
          const isDisabled = editVal === null;
          const isEdited = desc.isEdited(spec.name);
          const isAuthored = desc.isAuthored(spec.name);
          const displayVal = isDisabled
            ? (stage.baseline.values[spec.name] ?? '')
            : (editVal ?? stage.baseline.values[spec.name] ?? '');
          const isColor = spec.name.endsWith('color');
          const listId = `css-presets-${spec.name}`;
          return (
            <div key={spec.name} className="flex items-center gap-1.5 py-1">
              <input
                type="checkbox"
                checked={!isDisabled && (isEdited || isAuthored)}
                aria-label={`Toggle ${spec.name}`}
                onChange={(e) => {
                  if (e.target.checked) applyAction({ kind: 'enable', property: spec.name });
                  else applyAction({ kind: 'disable', property: spec.name });
                }}
                className="h-3 w-3 shrink-0 accent-[#3a96dd]"
              />
              <span
                className={cn(
                  'w-28 shrink-0 truncate font-mono text-[10px]',
                  isDisabled && 'line-through opacity-50',
                  isEdited
                    ? 'font-semibold text-[#3a96dd]'
                    : isAuthored
                      ? 'text-foreground'
                      : 'text-muted-foreground'
                )}
                title={spec.name}
              >
                {spec.name}
              </span>
              {isColor && (
                <input
                  type="color"
                  aria-label={`${spec.name} color picker`}
                  value={/^#[0-9a-fA-F]{6}$/.test(displayVal) ? displayVal : '#3a96dd'}
                  onChange={(e) =>
                    applyAction({ kind: 'edit', property: spec.name, value: e.target.value })
                  }
                  className="h-4 w-4 shrink-0 cursor-pointer rounded border bg-transparent p-0"
                />
              )}
              <input
                type="text"
                list={spec.presets?.length ? listId : undefined}
                value={displayVal}
                disabled={isDisabled}
                onChange={(e) =>
                  applyAction({ kind: 'edit', property: spec.name, value: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                  const next = stepCssValue(
                    displayVal,
                    e.key === 'ArrowUp' ? 1 : -1,
                    e.shiftKey,
                    spec
                  );
                  if (next !== null) {
                    e.preventDefault();
                    e.stopPropagation();
                    applyAction({ kind: 'edit', property: spec.name, value: next });
                  }
                }}
                className={cn(
                  'min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 font-mono text-[10px] outline-none focus:border-ring',
                  isDisabled && 'opacity-40'
                )}
              />
              {spec.presets && spec.presets.length > 0 && (
                <datalist id={listId}>
                  {spec.presets.map((p) => (
                    <option key={p} value={p} />
                  ))}
                  {stage.baseline.variables.lengths.map((v) => (
                    <option key={v.name} value={`var(${v.name})`} />
                  ))}
                  {isColor &&
                    stage.baseline.variables.colors.map((v) => (
                      <option key={v.name} value={`var(${v.name})`} />
                    ))}
                </datalist>
              )}
              {(isEdited || isDisabled) && (
                <button
                  type="button"
                  aria-label={`Reset ${spec.name}`}
                  title="Reset property"
                  onClick={() => applyAction({ kind: 'reset', property: spec.name })}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <RotateCcw className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 舞台浮层：Region 8向调整 + Freedraw 画布 + 浮动标注编辑卡片
 */
export function BrowserAnnotateStageOverlay({
  tabId,
  conversationId,
  stageSize,
  draftPick,
  openPin,
  markupTool,
  warningShown,
  onWarningShownChange,
  onDraftPickChange,
  onMoveSelection,
  onCancelDraft,
  onCloseOpenPin,
  onSendQueue,
  onStrokeStateChange,
}: {
  tabId: string;
  conversationId: string;
  stageSize: { width: number; height: number };
  draftPick: DraftPickState | null;
  openPin: OpenPinState | null;
  markupTool: RegionMarkupTool | null;
  warningShown: boolean;
  onWarningShownChange: (shown: boolean) => void;
  onDraftPickChange: (next: DraftPickState | null) => void;
  onMoveSelection: (direction: BrowserDesignMoveDirection) => void;
  onCancelDraft: () => void;
  onCloseOpenPin: () => void;
  onSendQueue: (subsetIds?: ReadonlySet<string>) => void;
  onStrokeStateChange: (active: boolean) => void;
}) {
  const { t } = useI18n();
  const sendImmediately = useDesignAnnotationsStore((s) => s.annotateSendImmediately);
  const setSendImmediately = useDesignAnnotationsStore((s) => s.setSendImmediately);
  const addAnnotation = useDesignAnnotationsStore((s) => s.addAnnotation);
  const updateAnnotation = useDesignAnnotationsStore((s) => s.updateAnnotation);
  const removeAnnotations = useDesignAnnotationsStore((s) => s.removeAnnotations);
  const allNotes = useDesignAnnotationsStore((s) => s.annotationsFor(conversationId));

  const editingPinAnnotation = useMemo(
    () => (openPin ? (allNotes.find((n) => n.id === openPin.id) ?? null) : null),
    [allNotes, openPin]
  );

  const initialSplit = useMemo(
    () => splitCommentCssBlock(editingPinAnnotation?.comment ?? ''),
    [editingPinAnnotation?.comment]
  );

  const [commentText, setCommentText] = useState('');
  const [extraImages, setExtraImages] = useState<DesignAnnotationImage[]>([]);
  const [cssInspectorOpen, setCssInspectorOpen] = useState(false);
  const [cssPinned, setCssPinned] = useState(false);
  const [cssStage, setCssStage] = useState<CssStageState | null>(null);
  const [nudge, setNudge] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [regionDrag, setRegionDrag] = useState<RegionDragState | null>(null);
  const [hoverHandle, setHoverHandle] = useState<RegionResizeHandle>('move');
  const [activeShape, setActiveShape] = useState<RegionMarkupShape | null>(null);
  const activeShapeOriginRef = useRef<{ x: number; y: number } | null>(null);
  const cardDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    nudgeX: number;
    nudgeY: number;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const batchSwitchId = useId();

  // Reset card state when target draft or openPin changes
  const activeTargetKey = openPin ? `pin:${openPin.id}` : draftPick ? 'draft' : 'none';
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when active target identity changes
  useEffect(() => {
    setCommentText(initialSplit.prose);
    setExtraImages(editingPinAnnotation ? editingPinAnnotation.images.slice(1) : []);
    setCssInspectorOpen(false);
    setCssStage(null);
    setNudge({ x: 0, y: 0 });
    onWarningShownChange(false);
    window.setTimeout(() => textareaRef.current?.focus(), 10);
  }, [activeTargetKey]);

  // Sync queued CSS edits to guest page whenever queue changes
  useEffect(() => {
    const queued = queuedCssEditsOf(allNotes.filter((n) => n.browserId === tabId));
    void window.electronAPI.browser.previewDesignCss(tabId, 'queue', queued);
  }, [allNotes, tabId]);

  const activeElements: BrowserElementSnapshot[] = useMemo(() => {
    if (editingPinAnnotation) {
      return editingPinAnnotation.kind === 'element' ? editingPinAnnotation.elements : [];
    }
    return draftPick?.description.elements ?? [];
  }, [editingPinAnnotation, draftPick]);

  const singleElement = activeElements.length === 1 ? activeElements[0]! : null;

  const openCssInspector = useCallback(async () => {
    if (!singleElement) return;
    if (cssInspectorOpen) {
      setCssInspectorOpen(false);
      return;
    }
    const snapshot: DesignCssSnapshot | null = await window.electronAPI.browser.readDesignCss(
      tabId,
      singleElement.uniqueId
    );
    if (!snapshot) {
      addToast({ type: 'warning', title: t('Could not read CSS for this element') });
      return;
    }
    setCssStage(createCssStage(snapshot, initialSplit.css));
    setCssInspectorOpen(true);
  }, [singleElement, cssInspectorOpen, tabId, initialSplit.css, t]);

  // Undo/Redo for region markup (⌘Z / ⌘⇧Z)
  useEffect(() => {
    if (!draftPick?.region) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      if (!mod || event.altKey || event.key.toLowerCase() !== 'z') return;
      const noteOwnsUndo = document.activeElement === textareaRef.current && commentText.length > 0;
      if (
        !ownsMarkupUndo({
          markCount: draftPick.markup.length + draftPick.redoMarkup.length,
          toolHeld: markupTool !== null,
          noteOwnsUndo,
        })
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        const next = draftPick.redoMarkup.at(-1);
        if (!next) return;
        onDraftPickChange({
          ...draftPick,
          markup: [...draftPick.markup, next],
          redoMarkup: draftPick.redoMarkup.slice(0, -1),
        });
      } else {
        const last = draftPick.markup.at(-1);
        if (!last) return;
        onDraftPickChange({
          ...draftPick,
          markup: draftPick.markup.slice(0, -1),
          redoMarkup: [...draftPick.redoMarkup, last],
        });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [draftPick, markupTool, commentText.length, onDraftPickChange]);

  // Keyboard modifier listeners during active region resize drag
  useEffect(() => {
    if (!regionDrag || !draftPick) return;
    const bounds: DesignTopLeftRect = {
      left: 0,
      top: 0,
      width: stageSize.width,
      height: stageSize.height,
    };
    const onKey = (event: KeyboardEvent, down: boolean) => {
      const key =
        event.key === ' '
          ? 'Space'
          : event.key === 'Shift' || event.key === 'Alt' || event.key === 'Escape'
            ? event.key
            : null;
      if (!key) return;
      if (key === 'Space') event.preventDefault();
      setRegionDrag((cur) =>
        cur ? stepRegionDrag(cur, { type: 'key', key, down }, bounds) : null
      );
    };
    const downHandler = (e: KeyboardEvent) => onKey(e, true);
    const upHandler = (e: KeyboardEvent) => onKey(e, false);
    window.addEventListener('keydown', downHandler, true);
    window.addEventListener('keyup', upHandler, true);
    return () => {
      window.removeEventListener('keydown', downHandler, true);
      window.removeEventListener('keyup', upHandler, true);
    };
  }, [regionDrag, draftPick, stageSize.width, stageSize.height]);

  const cssDesc = useMemo(() => (cssStage ? describeCssStage(cssStage) : null), [cssStage]);
  const hasCssEdits = Boolean(cssDesc && cssDesc.changes.size > 0);
  const hasTypedComment = commentText.trim().length > 0;
  const isSavedPin = editingPinAnnotation !== null;
  const isDirty = isSavedPin
    ? commentText.trim() !== initialSplit.prose.trim() || Boolean(cssDesc?.isDirty)
    : hasTypedComment || hasCssEdits || (draftPick?.markup.length ?? 0) > 0;

  const finalComment = useMemo(() => {
    if (cssDesc) {
      return mergeCommentCssBlock(commentText, cssDesc.changes);
    }
    if (initialSplit.css.size > 0) {
      return mergeCommentCssBlock(commentText, initialSplit.css);
    }
    return commentText.trim();
  }, [commentText, cssDesc, initialSplit.css]);

  const canSubmit = isSavedPin
    ? true
    : finalComment.length > 0 ||
      (draftPick?.region !== null && (draftPick?.markup.length ?? 0) > 0);

  const submitAction = resolveNoteSubmitAction({
    sendImmediately,
    isOnStack: isSavedPin,
  });
  const submitLabel =
    hasCssEdits && !hasTypedComment
      ? NOTE_SUBMIT_LABELS[submitAction].css
      : NOTE_SUBMIT_LABELS[submitAction].note;

  const handleAddToChat = useCallback(() => {
    const elements = activeElements;
    if (elements.length === 0) return;
    let anyInserted = false;
    elements.forEach((el, idx) => {
      const id = `ui-${Date.now()}-${idx}`;
      const label = elementLabelOf(el);
      const primaryImg =
        idx === 0 && draftPick?.description.image
          ? {
              data: draftPick.description.image.data,
              mimeType: draftPick.description.image.mimeType,
            }
          : undefined;
      if (
        insertUiElementMention(
          {
            kind: 'ui-element',
            id,
            label,
            path: el.path || el.tagName.toLowerCase(),
            text:
              (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200) ||
              formatBrowserElementBlock(el),
            imageId: `img-${id}`,
          },
          primaryImg
        )
      ) {
        anyInserted = true;
      }
    });
    if (!anyInserted) {
      addToast({ type: 'warning', title: t('No Composer for this selection') });
    } else {
      requestFocusComposer();
      onCancelDraft();
    }
  }, [activeElements, draftPick?.description.image, onCancelDraft, t]);

  const handleSubmit = useCallback(async () => {
    if (busy || !canSubmit) return;
    setBusy(true);
    try {
      if (isSavedPin && editingPinAnnotation) {
        const updatedImages =
          editingPinAnnotation.images.length > 0
            ? [editingPinAnnotation.images[0]!, ...extraImages]
            : [...extraImages];
        updateAnnotation(conversationId, editingPinAnnotation.id, finalComment, updatedImages);
        void window.electronAPI.browser.previewDesignCss(tabId, 'draft', {});
        onCloseOpenPin();
        if (sendImmediately) {
          onSendQueue(new Set([editingPinAnnotation.id]));
        }
        return;
      }

      if (!draftPick) return;
      const id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `ann-${Date.now()}`;
      const pageKey = useDesignAnnotationsStore.getState().pageKeyOf(tabId) ?? 'http://localhost/';
      const primaryImage = draftPick.description.image;
      const images: DesignAnnotationImage[] = [];
      if (primaryImage) {
        const burnedData =
          draftPick.region && draftPick.markup.length > 0
            ? await burnMarkupIntoPngBase64({
                base64: primaryImage.data,
                markup: draftPick.markup,
                cropWidth: draftPick.region.width,
              })
            : primaryImage.data;
        images.push({
          id: `img-${id}`,
          data: burnedData,
          mimeType: primaryImage.mimeType,
          name: primaryImage.name,
          width: primaryImage.width,
          height: primaryImage.height,
        });
      }
      images.push(...extraImages);

      let created: DesignAnnotation | undefined;
      if (draftPick.region) {
        const fallbackAnchor: BrowserElementSnapshot = draftPick.description.regionAnchor ?? {
          tagName: 'BODY',
          id: '',
          uniqueId: 'region-root',
          className: '',
          innerText: '',
          path: 'body',
          attributes: [],
          rect: {
            top: draftPick.region.top,
            left: draftPick.region.left,
            width: draftPick.region.width,
            height: draftPick.region.height,
          },
          styles: {
            color: '',
            backgroundColor: '',
            fontSize: '',
            fontFamily: '',
            display: 'block',
            position: 'static',
          },
        };
        created = addAnnotation(conversationId, {
          id,
          kind: 'region',
          comment: finalComment,
          browserId: tabId,
          pageKey,
          images,
          region: {
            rect: draftPick.region,
            anchor: fallbackAnchor,
            markup: draftPick.markup,
          },
        });
      } else {
        created = addAnnotation(conversationId, {
          id,
          kind: 'element',
          comment: finalComment,
          browserId: tabId,
          pageKey,
          images,
          elements: draftPick.description.elements,
        });
      }

      void window.electronAPI.browser.previewDesignCss(tabId, 'draft', {});
      onCancelDraft();
      if (sendImmediately && created) {
        onSendQueue(new Set([created.id]));
      }
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    canSubmit,
    isSavedPin,
    editingPinAnnotation,
    extraImages,
    updateAnnotation,
    conversationId,
    finalComment,
    tabId,
    onCloseOpenPin,
    sendImmediately,
    onSendQueue,
    draftPick,
    addAnnotation,
    onCancelDraft,
  ]);

  const requestCancel = useCallback(() => {
    if (isDirty && !warningShown) {
      onWarningShownChange(true);
      return;
    }
    onWarningShownChange(false);
    void window.electronAPI.browser.previewDesignCss(tabId, 'draft', {});
    if (isSavedPin) onCloseOpenPin();
    else onCancelDraft();
  }, [
    isDirty,
    warningShown,
    onWarningShownChange,
    tabId,
    isSavedPin,
    onCloseOpenPin,
    onCancelDraft,
  ]);

  const ingestAttachedFiles = (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        setExtraImages((cur) => [
          ...cur,
          {
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            data: base64,
            mimeType: file.type,
            name: file.name,
          },
        ]);
      };
      reader.readAsDataURL(file);
    }
  };

  const currentRegion = regionDrag ? regionDrag.rect : (draftPick?.region ?? null);

  // Compute card position
  const cardWidth = Math.min(320, Math.max(240, stageSize.width - 16));
  const estimatedCardHeight = cssInspectorOpen ? 360 : 148;
  const baseCardPos = useMemo(() => {
    if (openPin) {
      return placePinEditor(openPin.badge, stageSize, {
        width: cardWidth,
        height: estimatedCardHeight,
      });
    }
    if (currentRegion) {
      return placeFloatingNoteCard(
        {
          x: currentRegion.left,
          y: currentRegion.top,
          width: currentRegion.width,
          height: currentRegion.height,
        },
        stageSize,
        cardWidth,
        estimatedCardHeight
      );
    }
    if (draftPick && draftPick.elements.length > 0) {
      const xs = draftPick.elements.map((e) => e.rect.x);
      const ys = draftPick.elements.map((e) => e.rect.y);
      const rights = draftPick.elements.map((e) => e.rect.x + e.rect.width);
      const bottoms = draftPick.elements.map((e) => e.rect.y + e.rect.height);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return placeFloatingNoteCard(
        {
          x,
          y,
          width: Math.max(...rights) - x,
          height: Math.max(...bottoms) - y,
        },
        stageSize,
        cardWidth,
        estimatedCardHeight
      );
    }
    return { x: 16, y: 16 };
  }, [openPin, currentRegion, draftPick, stageSize, cardWidth, estimatedCardHeight]);

  const cardLeft = cssPinned
    ? Math.max(8, stageSize.width - cardWidth - 8)
    : Math.max(8, Math.min(baseCardPos.x + nudge.x, stageSize.width - cardWidth - 8));
  const cardTop = cssPinned
    ? 8
    : Math.max(8, Math.min(baseCardPos.y + nudge.y, stageSize.height - 120));

  if (!draftPick && !openPin) return null;

  const frameSrc = draftPick?.description.frame
    ? `data:${draftPick.description.frame.mimeType};base64,${draftPick.description.frame.data}`
    : null;

  return (
    <div
      data-enso-float=""
      className="absolute inset-0 z-30 select-none overflow-hidden"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestCancel();
      }}
    >
      {/* Region static frame + dim mask + 8-way resize + SVG Freedraw canvas */}
      {draftPick && currentRegion && (
        <>
          {frameSrc && (
            <img
              src={frameSrc}
              alt=""
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full object-fill"
            />
          )}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-slate-950/35"
            style={{
              clipPath: `polygon(0% 0%, 0% 100%, ${currentRegion.left}px 100%, ${currentRegion.left}px ${currentRegion.top}px, ${currentRegion.left + currentRegion.width}px ${currentRegion.top}px, ${currentRegion.left + currentRegion.width}px ${currentRegion.top + currentRegion.height}px, ${currentRegion.left}px ${currentRegion.top + currentRegion.height}px, ${currentRegion.left}px 100%, 100% 100%, 100% 0%)`,
            }}
          />
          <div
            role="application"
            aria-label="Selected screenshot region"
            style={{
              left: currentRegion.left,
              top: currentRegion.top,
              width: currentRegion.width,
              height: currentRegion.height,
              cursor:
                markupTool !== null
                  ? 'crosshair'
                  : regionHandleCursor(
                      regionDrag ? regionDrag.handle : hoverHandle,
                      regionDrag !== null
                    ),
            }}
            onPointerMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const local = { x: e.clientX - box.left, y: e.clientY - box.top };
              if (markupTool !== null) {
                if (!activeShape || !activeShapeOriginRef.current) return;
                const clamped = {
                  x: Math.max(0, Math.min(currentRegion.width, local.x)),
                  y: Math.max(0, Math.min(currentRegion.height, local.y)),
                };
                if (activeShape.kind === 'pen') {
                  setActiveShape({
                    kind: 'pen',
                    points: appendSampledPoint(activeShape.points, clamped),
                  });
                } else {
                  const to = e.shiftKey
                    ? snapMarkupPoint({
                        kind: activeShape.kind,
                        from: activeShapeOriginRef.current,
                        to: clamped,
                      })
                    : clamped;
                  setActiveShape({
                    kind: activeShape.kind,
                    from: activeShapeOriginRef.current,
                    to,
                  });
                }
                return;
              }
              if (regionDrag) {
                const stageBox = e.currentTarget.parentElement?.getBoundingClientRect();
                const stagePt = {
                  x: e.clientX - (stageBox?.left ?? 0),
                  y: e.clientY - (stageBox?.top ?? 0),
                };
                setRegionDrag((cur) =>
                  cur
                    ? stepRegionDrag(
                        cur,
                        {
                          type: 'move',
                          point: stagePt,
                          altKey: e.altKey,
                          shiftKey: e.shiftKey,
                        },
                        { left: 0, top: 0, width: stageSize.width, height: stageSize.height }
                      )
                    : null
                );
                return;
              }
              setHoverHandle(regionHandleAt(local, currentRegion));
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              const box = e.currentTarget.getBoundingClientRect();
              const local = {
                x: Math.max(0, Math.min(currentRegion.width, e.clientX - box.left)),
                y: Math.max(0, Math.min(currentRegion.height, e.clientY - box.top)),
              };
              if (markupTool !== null) {
                activeShapeOriginRef.current = local;
                onStrokeStateChange(true);
                if (markupTool === 'pen') {
                  setActiveShape({ kind: 'pen', points: [local] });
                } else {
                  setActiveShape({ kind: markupTool, from: local, to: local });
                }
                return;
              }
              const stageBox = e.currentTarget.parentElement?.getBoundingClientRect();
              const stagePt = {
                x: e.clientX - (stageBox?.left ?? 0),
                y: e.clientY - (stageBox?.top ?? 0),
              };
              const handle = regionHandleAt(local, currentRegion);
              setRegionDrag(
                beginRegionDrag({
                  handle,
                  point: stagePt,
                  rect: currentRegion,
                  modifiers: { altKey: e.altKey, shiftKey: e.shiftKey },
                })
              );
            }}
            onPointerUp={async () => {
              if (activeShape) {
                const nextMarkup = appendSignificantMark(draftPick.markup, activeShape);
                setActiveShape(null);
                activeShapeOriginRef.current = null;
                onStrokeStateChange(false);
                if (nextMarkup.length !== draftPick.markup.length) {
                  onDraftPickChange({
                    ...draftPick,
                    markup: nextMarkup,
                    redoMarkup: [],
                  });
                }
                return;
              }
              if (regionDrag) {
                const finalRect = clampRegionToViewport({
                  rect: regionDrag.rect,
                  viewport: stageSize,
                });
                const translated = translateRegionMarkup({
                  markup: draftPick.markup,
                  from: draftPick.region ?? finalRect,
                  to: finalRect,
                  markupScale: 1,
                });
                setRegionDrag(null);
                const desc = await window.electronAPI.browser.describeSelection(tabId, {
                  x: finalRect.left,
                  y: finalRect.top,
                  width: finalRect.width,
                  height: finalRect.height,
                });
                onDraftPickChange({
                  ...draftPick,
                  region: finalRect,
                  markup: translated,
                  description: desc.image ? desc : draftPick.description,
                });
              }
            }}
            className="absolute box-border border-2 border-[#3a96dd] border-dashed shadow-lg"
          >
            {/* SVG Freedraw Layer */}
            <svg
              role="img"
              aria-label="Draw on screenshot region"
              width={currentRegion.width}
              height={currentRegion.height}
              className="pointer-events-none block h-full w-full overflow-visible"
            >
              {draftPick.markup.map((shape, sIdx) =>
                shapePaths(shape, 'complete').map((seg, pIdx) => (
                  <path
                    // biome-ignore lint/suspicious/noArrayIndexKey: ordered markup strokes
                    key={`${sIdx}-${pIdx}`}
                    d={seg.d}
                    data-design-markup-stroke=""
                    fill={seg.paint === 'fill' ? REGION_MARKUP_COLOR : 'none'}
                    stroke={seg.paint === 'stroke' ? REGION_MARKUP_COLOR : 'none'}
                    strokeWidth={seg.paint === 'stroke' ? REGION_MARKUP_STROKE_WIDTH : undefined}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))
              )}
              {activeShape &&
                shapePaths(activeShape, 'active').map((seg, pIdx) => (
                  <path
                    // biome-ignore lint/suspicious/noArrayIndexKey: active stroke preview
                    key={`active-${pIdx}`}
                    d={seg.d}
                    data-design-markup-stroke="active"
                    fill={seg.paint === 'fill' ? REGION_MARKUP_COLOR : 'none'}
                    stroke={seg.paint === 'stroke' ? REGION_MARKUP_COLOR : 'none'}
                    strokeWidth={seg.paint === 'stroke' ? REGION_MARKUP_STROKE_WIDTH : undefined}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
            </svg>

            {/* 8 Resize Corner/Edge Indicators */}
            {markupTool === null && (
              <>
                <span className="pointer-events-none absolute -top-1.5 -left-1.5 h-2.5 w-2.5 rounded-xs border border-[#3a96dd] bg-white shadow-2xs" />
                <span className="pointer-events-none absolute -top-1.5 -right-1.5 h-2.5 w-2.5 rounded-xs border border-[#3a96dd] bg-white shadow-2xs" />
                <span className="pointer-events-none absolute -bottom-1.5 -left-1.5 h-2.5 w-2.5 rounded-xs border border-[#3a96dd] bg-white shadow-2xs" />
                <span className="pointer-events-none absolute -right-1.5 -bottom-1.5 h-2.5 w-2.5 rounded-xs border border-[#3a96dd] bg-white shadow-2xs" />
              </>
            )}
          </div>
        </>
      )}

      {/* Floating Note Editor Card (Cursor `ai` / `Mi` / `zr`) */}
      <div
        style={{ left: cardLeft, top: cardTop, width: cardWidth }}
        onMouseDown={(e) => e.stopPropagation()}
        className="glass-browser-design-input absolute z-40 flex flex-col overflow-hidden rounded-2xl border border-border/80 bg-popover/95 text-popover-foreground shadow-[0_14px_38px_-8px_rgba(0,0,0,0.32),0_4px_14px_-2px_rgba(0,0,0,0.16)] backdrop-blur-xl transition-shadow duration-150 focus-within:border-[#3a96dd]/55 focus-within:ring-2 focus-within:ring-[#3a96dd]/15 dark:border-white/12"
      >
        {/* Draggable Header with Element/Region Chips & Actions */}
        <div
          onPointerDown={(e) => {
            if (
              e.button !== 0 ||
              cssPinned ||
              (e.target instanceof Element && e.target.closest('button, input'))
            ) {
              return;
            }
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            cardDragRef.current = {
              pointerId: e.pointerId,
              startX: e.clientX,
              startY: e.clientY,
              nudgeX: nudge.x,
              nudgeY: nudge.y,
            };
          }}
          onPointerMove={(e) => {
            const drag = cardDragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;
            setNudge({
              x: drag.nudgeX + (e.clientX - drag.startX),
              y: drag.nudgeY + (e.clientY - drag.startY),
            });
          }}
          onPointerUp={() => {
            cardDragRef.current = null;
          }}
          className={cn(
            'flex items-center justify-between gap-2 px-3 pt-2.5 pb-1',
            !cssPinned && 'cursor-grab active:cursor-grabbing'
          )}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {currentRegion || editingPinAnnotation?.kind === 'region' ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-[#3a96dd]/25 bg-[#3a96dd]/12 px-2 py-0.5 text-[11px] font-medium text-[#3a96dd]">
                {draftPick?.description.image && (
                  <img
                    src={`data:${draftPick.description.image.mimeType};base64,${draftPick.description.image.data}`}
                    alt=""
                    className="h-4 w-5 rounded-[3px] object-cover ring-1 ring-black/10 dark:ring-white/15"
                  />
                )}
                <span>
                  Region{' '}
                  {Math.round(
                    currentRegion?.width ??
                      (editingPinAnnotation?.kind === 'region'
                        ? editingPinAnnotation.region.rect.width
                        : 0)
                  )}{' '}
                  ×{' '}
                  {Math.round(
                    currentRegion?.height ??
                      (editingPinAnnotation?.kind === 'region'
                        ? editingPinAnnotation.region.rect.height
                        : 0)
                  )}
                </span>
              </span>
            ) : (
              activeElements.map((el, idx) => {
                const hue =
                  PICKER_HUE_COLORS[(el.hueIndex ?? idx) % PICKER_HUE_COLORS.length] ??
                  PICKER_HUE_COLORS[0]!;
                const palette =
                  ANNOTATION_CANVAS_PALETTE[
                    (el.hueIndex ?? idx) % ANNOTATION_CANVAS_PALETTE.length
                  ] ?? ANNOTATION_CANVAS_PALETTE[0]!;
                return (
                  <span
                    key={el.uniqueId || `${el.tagName}-${idx}`}
                    style={{
                      backgroundColor: hue.bg,
                      borderColor: palette.stroke,
                      color: hue.border,
                    }}
                    title={`${elementIdentityLabelOf(el)} — ${el.path}`}
                    className="inline-flex max-w-48 items-center gap-1.5 truncate rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium shadow-2xs"
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: hue.border }}
                    />
                    <span className="truncate">{elementLabelOf(el)}</span>
                  </span>
                );
              })
            )}
          </div>

          <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
            {!isSavedPin && !currentRegion && activeElements.length === 1 && (
              <>
                <button
                  type="button"
                  onClick={() => onMoveSelection('parent')}
                  title="Select parent element (Shift+Enter or \)"
                  aria-label="Select parent element"
                  className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                >
                  <CornerLeftUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onMoveSelection('previous')}
                  title="Select previous sibling (Shift+Tab)"
                  aria-label="Select previous sibling"
                  className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                >
                  <ArrowLeft className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onMoveSelection('next')}
                  title="Select next sibling (Tab)"
                  aria-label="Select next sibling"
                  className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                >
                  <ArrowRight className="h-3 w-3" />
                </button>
              </>
            )}
            {activeElements.length > 0 && (
              <button
                type="button"
                onClick={handleAddToChat}
                title={`Add element to chat (${IS_MAC ? '⌘L' : 'Ctrl+L'})`}
                aria-label="Add element to chat"
                className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
              >
                <MessageSquarePlus className="h-3 w-3" />
              </button>
            )}
            {singleElement && (
              <button
                type="button"
                onClick={() => void openCssInspector()}
                aria-label="Edit CSS properties"
                aria-pressed={cssInspectorOpen}
                title="Edit CSS properties"
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-md transition-colors',
                  cssInspectorOpen || hasCssEdits
                    ? 'bg-[#3a96dd]/15 text-[#3a96dd]'
                    : 'text-muted-foreground hover:bg-background/80 hover:text-foreground'
                )}
              >
                <SlidersHorizontal className="h-3 w-3" />
              </button>
            )}
            {isSavedPin && editingPinAnnotation && (
              <button
                type="button"
                aria-label="Delete annotation"
                title="Delete annotation"
                onClick={() => {
                  removeAnnotations(conversationId, [editingPinAnnotation.id]);
                  onCloseOpenPin();
                }}
                className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {/* Attached Extra Images Row */}
        {extraImages.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-1.5">
            {extraImages.map((img) => (
              <div
                key={img.id}
                className="group relative h-11 w-15 overflow-hidden rounded-lg border border-border/70 shadow-2xs"
              >
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt=""
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  aria-label="Remove attached image"
                  onClick={() => setExtraImages((cur) => cur.filter((item) => item.id !== img.id))}
                  className="absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Comment Textarea */}
        <div className="px-3 py-1.5">
          <textarea
            ref={textareaRef}
            rows={2}
            value={commentText}
            onChange={(e) => {
              setCommentText(e.target.value);
              if (warningShown) onWarningShownChange(false);
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(144, Math.max(44, el.scrollHeight))}px`;
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length > 0) {
                e.preventDefault();
                ingestAttachedFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              const mod = IS_MAC ? e.metaKey : e.ctrlKey;
              if (mod && e.key.toLowerCase() === 'l') {
                e.preventDefault();
                e.stopPropagation();
                handleAddToChat();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                if (canSubmit || mod) {
                  e.preventDefault();
                  e.stopPropagation();
                  void handleSubmit();
                  return;
                }
                if (!isSavedPin && !currentRegion && activeElements.length > 0) {
                  e.preventDefault();
                  e.stopPropagation();
                  onMoveSelection('child');
                  return;
                }
              }
              if (!canSubmit && !isSavedPin && !currentRegion && activeElements.length > 0) {
                if ((e.key === 'Enter' && e.shiftKey) || e.key === '\\') {
                  e.preventDefault();
                  e.stopPropagation();
                  onMoveSelection('parent');
                  return;
                }
                if (e.key === 'Tab') {
                  e.preventDefault();
                  e.stopPropagation();
                  onMoveSelection(e.shiftKey ? 'previous' : 'next');
                  return;
                }
              }
              if (
                isSavedPin &&
                editingPinAnnotation &&
                !hasTypedComment &&
                !hasCssEdits &&
                (e.key === 'Backspace' || e.key === 'Delete') &&
                !e.altKey &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.repeat
              ) {
                e.preventDefault();
                e.stopPropagation();
                removeAnnotations(conversationId, [editingPinAnnotation.id]);
                onCloseOpenPin();
              }
            }}
            placeholder={hasCssEdits ? 'Add a note (optional)…' : 'Describe the change…'}
            className="min-h-[44px] w-full resize-none bg-transparent text-[13px] leading-5 outline-none placeholder:text-muted-foreground/60"
          />
          {hasCssEdits && !cssInspectorOpen && cssDesc && (
            <section
              aria-label="CSS edits"
              className="mt-1.5 flex flex-wrap gap-1 text-[10px] text-[#3a96dd]"
            >
              {[...cssDesc.changes].map(([prop, change]) => (
                <span
                  key={prop}
                  className="inline-flex items-center gap-1 rounded-md border border-[#3a96dd]/20 bg-[#3a96dd]/10 px-1.5 py-0.5 font-mono"
                >
                  <span className="font-medium">{prop}:</span>
                  {change.to === null ? (
                    <span>removed</span>
                  ) : (
                    <>
                      <del className="opacity-65">{change.from}</del>
                      <span className="opacity-60">→</span>
                      <ins className="font-semibold no-underline">{change.to}</ins>
                    </>
                  )}
                </span>
              ))}
            </section>
          )}
        </div>

        {/* CSS Inspector Panel */}
        {cssInspectorOpen && cssStage && singleElement && (
          <CssInspectorPanel
            stage={cssStage}
            pinned={cssPinned}
            onTogglePinned={() => setCssPinned((p) => !p)}
            onClose={() => setCssInspectorOpen(false)}
            onStageChange={(nextStage, filed) => {
              setCssStage(nextStage);
              void window.electronAPI.browser.previewDesignCss(tabId, 'draft', {
                [singleElement.uniqueId]: filed,
              });
            }}
          />
        )}

        {/* Unsaved Discard Confirmation Notice */}
        {warningShown && (
          <div
            data-design-input-notice=""
            className="flex items-center justify-between gap-2 border-t bg-amber-500/10 px-2.5 py-1.5 text-[11px]"
          >
            <div className="min-w-0">
              <span className="font-semibold text-amber-600 dark:text-amber-400">
                Discard comment?
              </span>{' '}
              <span className="text-muted-foreground">This comment isn't saved yet.</span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => onWarningShownChange(false)}
                className="rounded border bg-background px-2 py-0.5 text-[10px] font-medium hover:bg-muted"
              >
                Keep Editing
              </button>
              <button
                type="button"
                onClick={() => {
                  onWarningShownChange(false);
                  void window.electronAPI.browser.previewDesignCss(tabId, 'draft', {});
                  if (isSavedPin) onCloseOpenPin();
                  else onCancelDraft();
                }}
                className="rounded bg-destructive px-2 py-0.5 text-[10px] font-medium text-white hover:opacity-90"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {/* Footer Bar: Attach image, Batch edits toggle, Submit button */}
        <div className="flex items-center justify-between gap-2 border-t border-border/50 bg-muted/20 px-3 py-2">
          <div className="flex items-center gap-2.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                ingestAttachedFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach image to annotation"
              title="Attach image"
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ImagePlus className="h-3.5 w-3.5" />
            </button>
            <label
              htmlFor={batchSwitchId}
              className="group flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <input
                id={batchSwitchId}
                type="checkbox"
                checked={!sendImmediately}
                onChange={(e) => setSendImmediately(!e.target.checked)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={cn(
                  'relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors duration-150',
                  !sendImmediately ? 'bg-[#3a96dd]' : 'bg-muted-foreground/30'
                )}
              >
                <span
                  className={cn(
                    'inline-block h-2.5 w-2.5 rounded-full bg-white shadow-2xs transition-transform duration-150',
                    !sendImmediately ? 'translate-x-3' : 'translate-x-0.5'
                  )}
                />
              </span>
              <span>Batch edits</span>
            </label>
          </div>
          <button
            type="button"
            disabled={busy || !canSubmit}
            aria-label={submitLabel}
            title={`${submitLabel} (Enter)`}
            onClick={() => void handleSubmit()}
            className="flex h-7 items-center gap-1.5 rounded-lg bg-[#3a96dd] px-3 text-[11px] font-medium text-white shadow-xs transition-all hover:bg-[#3286c9] active:scale-[0.98] disabled:bg-muted disabled:text-muted-foreground disabled:opacity-50"
          >
            {submitAction === 'add-to-stack' ? (
              <Plus className="h-3 w-3" />
            ) : submitAction === 'save-note' ? (
              <Check className="h-3 w-3" />
            ) : (
              <ArrowUp className="h-3 w-3" />
            )}
            <span>{submitLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 供 BrowserView 调用的完整 Annotate 会话 Hook
 */
export function useBrowserAnnotateSession({
  tabId,
  conversationId,
  url,
  designMode,
  onDesignModeState,
}: {
  tabId: string;
  conversationId: string;
  url: string;
  designMode: boolean;
  onDesignModeState: (
    next: Awaited<ReturnType<typeof window.electronAPI.browser.setDesignMode>>
  ) => void;
}) {
  const { t } = useI18n();
  const [drawing, setDrawing] = useState(false);
  const [draftPick, setDraftPick] = useState<DraftPickState | null>(null);
  const [openPin, setOpenPin] = useState<OpenPinState | null>(null);
  const [markupTool, setMarkupTool] = useState<RegionMarkupTool | null>(null);
  const [markupStrokeActive, setMarkupStrokeActive] = useState(false);
  const [warningShown, setWarningShown] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);

  const annotations = useDesignAnnotationsStore((s) => s.annotationsFor(conversationId, tabId));
  const allConversationAnnotations = useDesignAnnotationsStore((s) =>
    s.annotationsFor(conversationId)
  );
  const lastUrlRef = useRef(url);

  // Sync URL and register session in store
  useEffect(() => {
    if (url) useDesignAnnotationsStore.getState().setBrowserUrl(tabId, url);
    if (lastUrlRef.current !== url) {
      lastUrlRef.current = url;
      setDraftPick(null);
      setOpenPin(null);
      setWarningShown(false);
      setDrawing(false);
      setMarkupStrokeActive(false);
    }
  }, [tabId, url]);

  const setDesignMode = useCallback(
    async (enabled: boolean) => {
      if (enabled) useDesignAnnotationsStore.getState().markEntered();
      else {
        setDraftPick(null);
        setOpenPin(null);
        setMarkupTool(null);
        setWarningShown(false);
        setDrawing(false);
      }
      const nextState = await window.electronAPI.browser.setDesignMode(tabId, enabled);
      onDesignModeState(nextState);
    },
    [tabId, onDesignModeState]
  );

  // Sync annotation pins to guest page whenever annotations or URL or designMode change
  useEffect(() => {
    if (!designMode || !url) return;
    const pageKey = designModePageKey(url);
    const matching = annotations
      .filter((item) => item.pageKey === pageKey)
      .map(annotationPinSpecOf);
    void window.electronAPI.browser.setAnnotationPins(tabId, pageKey, matching);
  }, [designMode, url, annotations, tabId]);

  // Handle switching markup tool when an element is selected -> convert element bounding box into region
  const handleMarkupToolChange = useCallback(
    (nextTool: RegionMarkupTool | null) => {
      setMarkupTool(nextTool);
      if (
        nextTool !== null &&
        draftPick &&
        draftPick.region === null &&
        draftPick.elements.length > 0
      ) {
        const xs = draftPick.elements.map((e) => e.rect.x);
        const ys = draftPick.elements.map((e) => e.rect.y);
        const rights = draftPick.elements.map((e) => e.rect.x + e.rect.width);
        const bottoms = draftPick.elements.map((e) => e.rect.y + e.rect.height);
        const left = Math.max(0, Math.min(...xs) - 12);
        const top = Math.max(0, Math.min(...ys) - 12);
        const width = Math.max(24, Math.max(...rights) - left + 12);
        const height = Math.max(24, Math.max(...bottoms) - top + 12);
        setDraftPick({
          ...draftPick,
          region: { left, top, width, height },
        });
      }
    },
    [draftPick]
  );

  // Subscribe to BrowserDesignModeEvent from Main
  useEffect(() => {
    return window.electronAPI.browser.onDesignMode((event: BrowserDesignModeEvent) => {
      if (event.tabId !== tabId) return;
      if (event.type === 'cancelled') {
        setDraftPick(null);
        setOpenPin(null);
        setMarkupTool(null);
        setDrawing(false);
        return;
      }
      if (event.type === 'drawing') {
        setDrawing(event.drawing);
        return;
      }
      if (event.type === 'pins') {
        useDesignAnnotationsStore.getState().setPinnedIds(tabId, event.ids);
        return;
      }
      if (event.type === 'pin-click') {
        setDraftPick(null);
        setWarningShown(false);
        if (event.pin) {
          setOpenPin({ id: event.id, badge: event.pin });
        }
        return;
      }
      if (event.type === 'select') {
        setDrawing(false);
        setOpenPin(null);
        setWarningShown(false);
        if (event.addToChat && event.description.elements.length > 0) {
          event.description.elements.forEach((el, idx) => {
            const id = `ui-${Date.now()}-${idx}`;
            const label = elementLabelOf(el);
            const img =
              idx === 0 && event.description.image
                ? {
                    data: event.description.image.data,
                    mimeType: event.description.image.mimeType,
                  }
                : undefined;
            insertUiElementMention(
              {
                kind: 'ui-element',
                id,
                label,
                path: el.path || el.tagName.toLowerCase(),
                text:
                  (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200) ||
                  formatBrowserElementBlock(el),
                imageId: `img-${id}`,
              },
              img
            );
          });
          requestFocusComposer();
          void window.electronAPI.browser.clearSelection(tabId);
          return;
        }
        setDraftPick({
          elements: event.elements,
          region: event.region
            ? {
                left: event.region.x,
                top: event.region.y,
                width: event.region.width,
                height: event.region.height,
              }
            : null,
          viewportWidth: event.viewportWidth,
          description: event.description,
          markup: [],
          redoMarkup: [],
        });
      }
    });
  }, [tabId]);

  const cancelDraft = useCallback(() => {
    setDraftPick(null);
    setMarkupTool(null);
    setWarningShown(false);
    void window.electronAPI.browser.clearSelection(tabId);
  }, [tabId]);

  const closeOpenPin = useCallback(() => {
    setOpenPin(null);
    setWarningShown(false);
    void window.electronAPI.browser.openAnnotationPin(tabId, null, false);
  }, [tabId]);

  const moveSelection = useCallback(
    async (direction: BrowserDesignMoveDirection) => {
      const res = await window.electronAPI.browser.moveSelection(tabId, direction);
      if (res.elements.length === 0) return;
      setDraftPick((cur) =>
        cur
          ? {
              ...cur,
              elements: res.elements,
              description: res.description,
            }
          : null
      );
    },
    [tabId]
  );

  const openPinFromQueue = useCallback(
    async (annotation: DesignAnnotation) => {
      if (annotation.browserId !== tabId) {
        addToast({
          type: 'info',
          title: t("Turn on design mode in this note's browser tab to open it"),
        });
        return;
      }
      if (!designMode) {
        await setDesignMode(true);
      }
      const pin = await window.electronAPI.browser.openAnnotationPin(tabId, annotation.id, true);
      if (pin) {
        setDraftPick(null);
        setOpenPin({ id: annotation.id, badge: pin });
      }
    },
    [tabId, designMode, setDesignMode, t]
  );

  // Send annotations queue (optimistic remove + rollback on failure, matching Cursor `Tr()`)
  const sendQueue = useCallback(
    (subsetIds?: ReadonlySet<string>) => {
      const store = useDesignAnnotationsStore.getState();
      const currentQueue = store.annotationsFor(conversationId);
      const toSend = subsetIds
        ? currentQueue.filter((item) => subsetIds.has(item.id))
        : [...currentQueue];
      if (toSend.length === 0) return;

      const built = buildAnnotationsPrompt(toSend, (item) => item.pageKey);
      const ids = built.ordered.map((item) => item.id);
      store.removeAnnotations(conversationId, ids);

      const ok = submitComposerPayload({
        text: built.text,
        images: built.images,
        mentions: [],
      });
      if (!ok) {
        store.restoreAnnotations(conversationId, built.ordered);
        addToast({
          type: 'warning',
          title: t('Note not sent'),
          description: t('The note stays in the queue.'),
        });
        return;
      }
      if (store.annotationsFor(conversationId).length === 0 && designMode) {
        void setDesignMode(false);
      }
    },
    [conversationId, designMode, setDesignMode, t]
  );

  // Global shortcut ⌘⇧D & layered Escape key handling (Cursor `qo`)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        event.stopPropagation();
        void setDesignMode(!designMode);
        return;
      }
      if (!designMode || event.key !== 'Escape') return;
      const target = event.target instanceof Element ? event.target : null;
      const targetOwnsEscape =
        target?.closest(
          '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [aria-expanded="true"], [data-design-owns-escape]'
        ) !== null && target?.closest('[data-design-owns-escape]') !== null;
      const targetIsInput =
        target?.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
        ) !== null;

      if (queueOpen) {
        event.preventDefault();
        event.stopPropagation();
        setQueueOpen(false);
        return;
      }

      const action = resolveDesignEscapeAction({
        queueOwnsEscape: queueOpen,
        targetOwnsEscape,
        targetIsInput,
        markupStrokeActive,
        markupToolHeld: markupTool !== null,
        warningShown,
        draftOpen: draftPick !== null,
        editorOpen: openPin !== null,
      });

      switch (action) {
        case 'pass-through':
          return;
        case 'cancel-stroke':
          event.preventDefault();
          event.stopPropagation();
          setMarkupStrokeActive(false);
          return;
        case 'put-down-tool':
          event.preventDefault();
          event.stopPropagation();
          setMarkupTool(null);
          return;
        case 'dismiss-warning':
          event.preventDefault();
          event.stopPropagation();
          setWarningShown(false);
          return;
        case 'cancel-draft':
          event.preventDefault();
          event.stopPropagation();
          cancelDraft();
          return;
        case 'close-editor':
          event.preventDefault();
          event.stopPropagation();
          closeOpenPin();
          return;
        case 'exit':
          event.preventDefault();
          event.stopPropagation();
          void setDesignMode(false);
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    designMode,
    queueOpen,
    markupStrokeActive,
    markupTool,
    warningShown,
    draftPick,
    openPin,
    setDesignMode,
    cancelDraft,
    closeOpenPin,
  ]);

  return {
    drawing,
    draftPick,
    openPin,
    markupTool,
    warningShown,
    queueOpen,
    allConversationAnnotations,
    setQueueOpen,
    setWarningShown,
    setDraftPick,
    setDesignMode,
    handleMarkupToolChange,
    moveSelection,
    cancelDraft,
    closeOpenPin,
    openPinFromQueue,
    sendQueue,
    setMarkupStrokeActive,
  };
}
