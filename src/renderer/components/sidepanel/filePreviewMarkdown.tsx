import {
  classifyPreviewImageSrc,
  normalizeRemoteImageUrl,
  resolvePreviewImageRel,
} from '@shared/markdownPreviewImage';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { MarkdownCtx, markdownComponents } from '@/components/chat/Markdown';
import { buildFilePreviewSanitizeSchema, rehypeRejectUnsafeImageSrc } from './filePreviewSanitize';

const REMARK_PLUGINS = [remarkGfm];
const SANITIZE_SCHEMA = buildFilePreviewSanitizeSchema();
const REHYPE_PLUGINS = [
  rehypeRaw,
  [rehypeSanitize, SANITIZE_SCHEMA],
  rehypeRejectUnsafeImageSrc,
] as const;

/**
 * rehype-sanitize 放行的原始 HTML 属性（align/width/colSpan 等）经
 * hast-util-to-jsx-runtime 会作为普通 props 传给对应的 react-markdown 组件；
 * 聊天气泡的 `markdownComponents`（`p`/`h1-h3`/`ul`/`ol`/`th`/`td`）只解构了
 * `children`，会把这些属性静默丢掉——README 里 `<p align="center">`、原生
 * HTML 表格的 `colSpan` 都要靠它们才不走样。这里只给文件预览单独覆盖这几个
 * 标签、透传其余属性；聊天路径（`Markdown.tsx`）不动，行为不变。
 */
const pOverride: Components['p'] = ({ children, node: _node, ...rest }) => (
  <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0" {...rest}>
    {children}
  </p>
);
const h1Override: Components['h1'] = ({ children, node: _node, ...rest }) => (
  <h1 className="mt-3 mb-1.5 text-base font-semibold" {...rest}>
    {children}
  </h1>
);
const h2Override: Components['h2'] = ({ children, node: _node, ...rest }) => (
  <h2 className="mt-3 mb-1.5 text-base font-semibold" {...rest}>
    {children}
  </h2>
);
const h3Override: Components['h3'] = ({ children, node: _node, ...rest }) => (
  <h3 className="mt-2 mb-1 text-sm font-semibold" {...rest}>
    {children}
  </h3>
);
const ulOverride: Components['ul'] = ({ children, node: _node, ...rest }) => (
  <ul className="my-1.5 list-disc pl-5 space-y-0.5" {...rest}>
    {children}
  </ul>
);
const olOverride: Components['ol'] = ({ children, node: _node, ...rest }) => (
  <ol className="my-1.5 list-decimal pl-5 space-y-0.5" {...rest}>
    {children}
  </ol>
);
const thOverride: Components['th'] = ({ children, node: _node, ...rest }) => (
  <th className="border-b border-border px-2 py-1 text-left font-medium" {...rest}>
    {children}
  </th>
);
const tdOverride: Components['td'] = ({ children, node: _node, ...rest }) => (
  <td className="border-b border-border/50 px-2 py-1" {...rest}>
    {children}
  </td>
);

const passthroughComponents: Partial<Components> = {
  p: pOverride,
  h1: h1Override,
  h2: h2Override,
  h3: h3Override,
  ul: ulOverride,
  ol: olOverride,
  th: thOverride,
  td: tdOverride,
};

/**
 * Files 面板 Markdown 只读预览：在聊天 Markdown 组件基础上开放原始 HTML
 * （rehype-raw + rehype-sanitize 白名单），并把图片路径解析成安全可加载的资源：
 * - 工作区内相对路径 → 主进程按边界读盘，转 data URL；
 * - http(s)/协议相对远程图片 → 主进程带 SSRF 防护代理拉取，转 data URL；
 * - 已是 data: URL → 原样使用（sanitize 阶段已拒绝非位图 mime）。
 * 聊天气泡渲染（`components/chat/Markdown.tsx`）不引入这条链路，行为不变。
 */
export function FileMarkdownPreview({
  text,
  baseDirRel,
  resolveImage,
  resolveRemoteImage,
}: {
  text: string;
  /** 当前 Markdown 文件所在目录的工作区相对路径（根目录为 ""） */
  baseDirRel: string;
  /** 工作区相对路径 → data URL；失败或不支持返回 null */
  resolveImage: (rel: string) => Promise<string | null>;
  /** http(s) 绝对 URL → data URL（主进程代理，带 SSRF 防护）；失败或不支持返回 null */
  resolveRemoteImage: (url: string) => Promise<string | null>;
}) {
  const cacheRef = useRef(new Map<string, string>());
  const components = useMemo<Components>(() => {
    const imgOverride: Components['img'] = ({ node: _node, src, alt, ...rest }) => (
      <PreviewImage
        src={typeof src === 'string' ? src : undefined}
        alt={alt}
        rest={rest}
        baseDirRel={baseDirRel}
        resolveImage={resolveImage}
        resolveRemoteImage={resolveRemoteImage}
        cache={cacheRef.current}
      />
    );
    return {
      ...markdownComponents,
      ...passthroughComponents,
      img: imgOverride,
    };
  }, [baseDirRel, resolveImage, resolveRemoteImage]);
  const ctx = useMemo(() => ({ text, streaming: false, searchQuery: '', activeNth: -1 }), [text]);
  return (
    <MarkdownCtx.Provider value={ctx}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS as never}
        components={components}
        // react-markdown 自带的 urlTransform 默认协议白名单不含 `data:`，会把我们
        // 在 rehype-sanitize 里明确放行的 data: 图片 URI（及图片解析后注入的结果）撑空。
        // href/img.src 的协议安全已由 buildFilePreviewSanitizeSchema 与
        // rehypeRejectUnsafeImageSrc 在前面的 rehype 阶段处理完毕，这里直接透传不再二次抦截。
        urlTransform={(url) => url}
      >
        {text}
      </ReactMarkdown>
    </MarkdownCtx.Provider>
  );
}

function PreviewImage({
  src,
  alt,
  rest,
  baseDirRel,
  resolveImage,
  resolveRemoteImage,
  cache,
}: {
  src: string | undefined;
  alt: string | undefined;
  /** sanitize 放行的其余 img 属性（width/height/align/title 等），原样透传 */
  rest: Record<string, unknown>;
  baseDirRel: string;
  resolveImage: (rel: string) => Promise<string | null>;
  resolveRemoteImage: (url: string) => Promise<string | null>;
  cache: Map<string, string>;
}) {
  const kind = src ? classifyPreviewImageSrc(src) : 'unsupported';
  const cacheKey =
    kind === 'local' && src ? `local:${resolvePreviewImageRel(baseDirRel, src) ?? ''}` : src;
  const [resolved, setResolved] = useState<string | null>(() => {
    if (kind === 'data') return src ?? null;
    return cacheKey ? (cache.get(cacheKey) ?? null) : null;
  });
  useEffect(() => {
    if (!src || kind === 'unsupported') {
      setResolved(null);
      return;
    }
    if (kind === 'data') {
      setResolved(src);
      return;
    }
    const cached = cacheKey ? cache.get(cacheKey) : undefined;
    if (cached) {
      setResolved(cached);
      return;
    }
    let alive = true;
    const load =
      kind === 'local'
        ? (() => {
            const rel = resolvePreviewImageRel(baseDirRel, src);
            return rel ? resolveImage(rel) : Promise.resolve(null);
          })()
        : resolveRemoteImage(normalizeRemoteImageUrl(src));
    void load.then((dataUrl) => {
      if (!alive) return;
      if (dataUrl && cacheKey) cache.set(cacheKey, dataUrl);
      setResolved(dataUrl);
    });
    return () => {
      alive = false;
    };
  }, [src, kind, baseDirRel, resolveImage, resolveRemoteImage, cache, cacheKey]);
  if (!resolved) return null;
  return <img {...rest} src={resolved} alt={alt} className="max-w-full rounded" loading="lazy" />;
}
