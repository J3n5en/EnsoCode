import { Code, Eye, Maximize2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useOverlayGuard } from '@/hooks/useOverlayGuard';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { CodeBlock } from './CodeBlock';
import { CopyButton } from './CopyButton';
import {
  buildHtmlVizDocument,
  nextVizState,
  parseVizMessage,
  VIZ_INITIAL_STATE,
  VIZ_READY_TIMEOUT_MS,
  type VizMessage,
  type VizState,
  type VizTheme,
  vizThemeMessage,
} from './htmlViz';

/** 静态壳页面（public/html-viz.html）：主界面 CSP 禁内联脚本，srcdoc 直接挂会继承它 */
const SHELL = 'html-viz.html';

const ICON_BUTTON =
  'flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground';

/** 壳 → 内层 sandbox iframe；只认壳 window 发来的消息，内层直接 postMessage 给顶层会被丢弃 */
function VizFrame({
  srcdoc,
  theme,
  title,
  className,
  style,
  onMessage,
}: {
  srcdoc: string;
  theme: VizTheme;
  title: string;
  className?: string;
  style?: React.CSSProperties;
  onMessage: (msg: VizMessage) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWindowMessage = (event: MessageEvent) => {
      if (!frame.contentWindow || event.source !== frame.contentWindow) return;
      if ((event.data as { type?: unknown } | null)?.type === 'enso-viz-ready') {
        frame.contentWindow.postMessage({ type: 'enso-viz-init', srcdoc }, '*');
        frame.contentWindow.postMessage(vizThemeMessage(themeRef.current), '*');
        return;
      }
      const msg = parseVizMessage(event.data);
      if (msg) onMessageRef.current(msg);
    };
    window.addEventListener('message', onWindowMessage);
    frame.src = new URL(SHELL, document.baseURI).href;
    return () => {
      window.removeEventListener('message', onWindowMessage);
      frame.removeAttribute('src');
    };
  }, [srcdoc]);

  // 切主题只发消息，不重载
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(vizThemeMessage(theme), '*');
  }, [theme]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      referrerPolicy="no-referrer"
      className={cn('block w-full border-0', className)}
      style={style}
    />
  );
}

/** ```html-viz 围栏：流式中只显示源码（不执行脚本），写完后在沙箱 iframe 里渲染；PNG 导出需栅格化 iframe，暂不提供 */
export function HtmlVizRenderer({
  code,
  streaming = false,
}: {
  code: string;
  streaming?: boolean;
}) {
  if (streaming) return <CodeBlock code={code} language="html" streaming />;
  return <HtmlVizPreview key={code} code={code} />;
}

function HtmlVizPreview({ code }: { code: string }) {
  const { t } = useI18n();
  const theme: VizTheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  // 主题只用于首帧，之后靠消息切换；换主题不重建 srcdoc，iframe 不重载
  const [srcdoc] = useState(() => buildHtmlVizDocument({ code, theme }));
  const [viz, setViz] = useState<VizState>(VIZ_INITIAL_STATE);
  const [showSource, setShowSource] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  useOverlayGuard(fullscreen && viz.failure === null);

  useEffect(() => {
    if (viz.failure !== null || viz.height !== null) return;
    const timer = setTimeout(
      () => setViz((s) => nextVizState(s, { type: 'enso-viz-timeout' })),
      VIZ_READY_TIMEOUT_MS
    );
    return () => clearTimeout(timer);
  }, [viz.failure, viz.height]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const onMessage = useCallback((msg: VizMessage) => setViz((s) => nextVizState(s, msg)), []);

  const failed = viz.failure?.kind === 'error' ? viz.failure.message : null;
  const fallback = viz.failure !== null;
  // 脚本错误不再尝试渲染，卸载 iframe 杀掉它；超时只是占位，
  // 保持挂载、裁到 0 高度藏住，迟到的 height 上报后恢复成预览
  const frameAlive = viz.failure?.kind !== 'error';

  const title = t('Visualization preview');
  return (
    <div data-enso="html-viz" className="my-2 overflow-hidden rounded-lg border border-border">
      {fallback ? (
        <details>
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
            {t('Visualization failed to render, showing source')}
            {failed && `: ${failed}`}
          </summary>
          <div className="px-2 pb-2">
            <CodeBlock code={code} language="html" />
          </div>
        </details>
      ) : (
        <>
          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-2 py-1">
            <span className="font-mono text-xs text-muted-foreground">html-viz</span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                className={ICON_BUTTON}
                onClick={() => setShowSource((v) => !v)}
                title={showSource ? t('Show preview') : t('Show source')}
              >
                {showSource ? <Eye className="h-3.5 w-3.5" /> : <Code className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                className={ICON_BUTTON}
                onClick={() => setFullscreen(true)}
                title={t('View fullscreen')}
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
              <CopyButton text={code} className={ICON_BUTTON} />
            </div>
          </div>
          {showSource && (
            <div className="[&_[data-enso=code-block]>*]:my-0 [&_[data-enso=code-block]>*]:rounded-none [&_[data-enso=code-block]>*]:border-0">
              <CodeBlock code={code} language="html" />
            </div>
          )}
        </>
      )}
      {/* 切到源码只隐藏不卸载，保住可视化内部状态；超时降级也保活 iframe 以便迟到的 height 恢复 */}
      {frameAlive && (
        <VizFrame
          srcdoc={srcdoc}
          theme={theme}
          title={title}
          // fallback 时不能 hidden：iframe 宽度归零会让内容测出的高度失真，靠 height: 0 藏住即可
          className={cn(showSource && !fallback && 'hidden')}
          style={{ height: fallback ? 0 : (viz.height ?? 160) }}
          onMessage={onMessage}
        />
      )}
      {fullscreen && (
        <div
          className="fixed inset-0 flex flex-col bg-background"
          style={{ zIndex: Z_INDEX.TOAST }}
          data-enso-float=""
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/30 px-4 py-2">
            <span className="text-sm font-medium text-muted-foreground">{title}</span>
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background/95 transition-colors hover:bg-accent hover:text-accent-foreground"
              title={t('Exit fullscreen')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <VizFrame
            srcdoc={srcdoc}
            theme={theme}
            title={title}
            className="min-h-0 flex-1"
            onMessage={onMessage}
          />
        </div>
      )}
    </div>
  );
}
