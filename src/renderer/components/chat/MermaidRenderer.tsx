import { Maximize2, Minimize2, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { useSettingsStore } from '@/stores/settings';

const MERMAID_CDN_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

interface MermaidAPI {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string, container?: Element) => Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidAPI> | null = null;
let mermaidInstance: MermaidAPI | null = null;
let renderLock: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

async function getMermaid(): Promise<MermaidAPI> {
  if (mermaidInstance) return mermaidInstance;
  if (!mermaidPromise) {
    mermaidPromise = import(/* @vite-ignore */ MERMAID_CDN_URL).then((mod) => {
      mermaidInstance = (mod as { default: MermaidAPI }).default;
      return mermaidInstance;
    });
  }
  return mermaidPromise;
}

function withRenderLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = renderLock.then(fn, fn);
  renderLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** 挂到 document.body 再画，避免 flowchart htmlLabels 读 firstChild 时空指针 */
async function renderMermaidSvg(code: string, theme: string): Promise<string> {
  return withRenderLock(async () => {
    const mermaid = await getMermaid();
    mermaid.initialize({
      startOnLoad: false,
      theme,
      securityLevel: 'loose',
      fontFamily: 'inherit',
      suppressErrorRendering: true,
      flowchart: { htmlLabels: false, useMaxWidth: true },
    });

    const id = `ensoMermaid${++renderSeq}`;
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'position:absolute;left:-99999px;top:0;width:800px;height:600px;overflow:hidden;pointer-events:none;';
    document.body.appendChild(host);
    try {
      const { svg } = await mermaid.render(id, code, host);
      return svg;
    } finally {
      host.remove();
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
}

const ZOOM_STEP = 0.1;
const MIN_ZOOM = 0.1;

export function MermaidRenderer({
  code,
  streaming = false,
  className,
}: {
  code: string;
  streaming?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const theme = useSettingsStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const panStartRef = useRef({ x: 0, y: 0 });
  const svgContentRef = useRef<HTMLDivElement>(null);
  const hasDraggedRef = useRef(false);

  const resolvedTheme =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme === 'dark' || theme === 'sync-terminal'
        ? 'dark'
        : 'light';
  const mermaidTheme = resolvedTheme === 'dark' ? 'dark' : 'default';

  useEffect(() => {
    if (streaming) {
      setSvg(null);
      setError(null);
      return;
    }

    let cancelled = false;
    const renderDiagram = async () => {
      if (!code.trim()) {
        setSvg(null);
        setError(null);
        return;
      }
      try {
        const renderedSvg = await renderMermaidSvg(code, mermaidTheme);
        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('Mermaid render failed'));
          setSvg(null);
        }
      }
    };

    void renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [code, mermaidTheme, streaming, t]);

  const handleZoomIn = useCallback(() => setZoom((prev) => prev + ZOOM_STEP), []);
  const handleZoomOut = useCallback(
    () => setZoom((prev) => Math.max(prev - ZOOM_STEP, MIN_ZOOM)),
    []
  );
  const handleReset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);
  const handleExitFullscreen = useCallback(() => {
    setIsFullscreen(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleEnterFullscreen = useCallback(() => {
    setIsFullscreen(true);
    requestAnimationFrame(() => {
      const svgEl = svgContentRef.current?.querySelector('svg');
      const contentArea = svgContentRef.current?.getBoundingClientRect();
      if (!svgEl || !contentArea?.width || !contentArea.height) return;
      const svgRect = svgEl.getBoundingClientRect();
      const padding = 24;
      const fitScale = Math.min(
        (contentArea.width - padding * 2) / svgRect.width,
        (contentArea.height - padding * 2) / svgRect.height
      );
      setZoom(Math.round(fitScale * 100) / 100);
      setPan({ x: 0, y: 0 });
    });
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!isFullscreen) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setZoom((prev) => Math.round(Math.max(prev + delta, MIN_ZOOM) * 100) / 100);
    },
    [isFullscreen]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!isFullscreen || e.button !== 0) return;
      setIsDragging(true);
      hasDraggedRef.current = false;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      panStartRef.current = { ...pan };
    },
    [isFullscreen, pan]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasDraggedRef.current = true;
      setPan({ x: panStartRef.current.x + dx, y: panStartRef.current.y + dy });
    },
    [isDragging]
  );

  const handleMouseUp = useCallback(() => setIsDragging(false), []);
  const handleFullscreenContentClick = useCallback(
    (e: React.MouseEvent) => e.stopPropagation(),
    []
  );
  const handleFullscreenOverlayClick = useCallback(() => {
    if (!hasDraggedRef.current) handleExitFullscreen();
  }, [handleExitFullscreen]);

  const zoomControls = (size: 'sm' | 'md') => {
    const box = size === 'sm' ? 'h-6 w-6' : 'h-7 w-7';
    const icon = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
    const pct = size === 'sm' ? 'h-6 min-w-[2.5rem]' : 'h-7 min-w-[3rem]';
    return (
      <div className="flex items-center gap-1 rounded-md border border-border bg-background/95 p-1 shadow-sm">
        <button
          type="button"
          onClick={handleZoomIn}
          className={cn(
            'flex items-center justify-center rounded text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
            box
          )}
          title={t('Zoom in')}
        >
          <Plus className={icon} />
        </button>
        <button
          type="button"
          onClick={handleReset}
          className={cn(
            'flex items-center justify-center rounded text-xs transition-colors hover:bg-accent hover:text-accent-foreground',
            pct
          )}
          title={t('Reset zoom')}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={handleZoomOut}
          disabled={zoom <= MIN_ZOOM}
          className={cn(
            'flex items-center justify-center rounded text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
            box,
            zoom <= MIN_ZOOM && 'cursor-not-allowed opacity-50'
          )}
          title={t('Zoom out')}
        >
          <Minus className={icon} />
        </button>
        {zoom !== 1 && (
          <button
            type="button"
            onClick={handleReset}
            className={cn(
              'flex items-center justify-center rounded text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
              box
            )}
            title={t('Fit to original size')}
          >
            <RotateCcw className={icon} />
          </button>
        )}
        <div className="mx-0.5 h-4 w-px bg-border" />
        {isFullscreen ? (
          <button
            type="button"
            onClick={handleExitFullscreen}
            className={cn(
              'flex items-center justify-center rounded text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
              box
            )}
            title={t('Exit fullscreen')}
          >
            <Minimize2 className={icon} />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleEnterFullscreen}
            className={cn(
              'flex items-center justify-center rounded text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
              box
            )}
            title={t('View fullscreen')}
          >
            <Maximize2 className={icon} />
          </button>
        )}
      </div>
    );
  };

  if (error) {
    return (
      <div className={cn('overflow-x-auto rounded-lg border border-destructive/50', className)}>
        <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>{t('Mermaid render error')}</span>
        </div>
        <pre className="p-4 text-sm">
          <code className="block font-mono leading-relaxed text-muted-foreground">{code}</code>
        </pre>
        <div className="border-t border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {error}
        </div>
      </div>
    );
  }

  if (!svg) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-lg border border-border bg-muted/30 p-8',
          className
        )}
      >
        <div className="text-sm text-muted-foreground">{t('Loading Mermaid diagram...')}</div>
      </div>
    );
  }

  return (
    <div
      className={cn('relative rounded-lg border border-border bg-muted/30', className)}
      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
    >
      <div
        ref={containerRef}
        className={cn(
          'overflow-hidden',
          isFullscreen && (isDragging ? 'cursor-grabbing' : 'cursor-grab')
        )}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={isFullscreen ? undefined : handleEnterFullscreen}
      >
        <div
          className="origin-center transition-transform duration-100 ease-out"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <div
            className="p-4"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid 输出的 SVG
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>

      <div className="absolute right-2 bottom-2">{zoomControls('sm')}</div>

      {isFullscreen && (
        <div
          className="fixed inset-0 flex select-none flex-col bg-background"
          style={{ zIndex: Z_INDEX.TOAST }}
          onClick={handleFullscreenOverlayClick}
        >
          <div
            className="flex shrink-0 items-center justify-between border-b border-border bg-muted/30 px-4 py-2"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-sm font-medium text-muted-foreground">
              {t('Mermaid preview')}
            </span>
            <button
              type="button"
              onClick={handleExitFullscreen}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background/95 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              title={t('Exit fullscreen')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="relative min-h-0 flex-1">
            <div
              ref={svgContentRef}
              className={cn(
                'absolute inset-0 flex select-none items-center justify-center overflow-hidden',
                isDragging ? 'cursor-grabbing' : 'cursor-grab'
              )}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onClick={handleFullscreenContentClick}
            >
              <div
                className="origin-center transition-transform duration-100 ease-out"
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
              >
                <div
                  className="p-4"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid 输出的 SVG
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              </div>
            </div>
            <div className="absolute right-4 bottom-4">{zoomControls('md')}</div>
          </div>
        </div>
      )}
    </div>
  );
}
