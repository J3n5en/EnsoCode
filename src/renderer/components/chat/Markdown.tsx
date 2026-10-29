import { previewImageMime } from '@shared/markdownPreviewImage';
import { FolderOpen } from 'lucide-react';
import type { Root } from 'mdast';
import {
  createContext,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import { revealLabel } from '@/components/sidepanel/fileTreeMenu';
import { WorkspaceImagePreview } from '@/components/sidepanel/WorkspaceImagePreview';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { openSidePanelFile } from '@/lib/sidePanelDock';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { CodeBlock } from './CodeBlock';
import { CopyButton } from './CopyButton';
import { highlightNode } from './highlightQuery';
import { MermaidRenderer } from './MermaidRenderer';
import {
  classifyMarkdownLink,
  splitFileLineRef,
  toExternalAbsolutePath,
  toWorkspaceRelativePath,
} from './markdownLinks';

/**
 * 解析代码围栏的 info 串。除了纯语言名（```ts），agent 常输出
 * "8:8:README.md" 这类「行号:行号:文件名」格式——取文件扩展名当语言。
 */
function parseFenceLang(info?: string): string | undefined {
  if (!info) return undefined;
  const last = info.split(':').at(-1) ?? info;
  const ext = /\.(\w+)$/.exec(last)?.[1];
  if (ext) return ext;
  return /^[\w-]+$/.test(info) ? info : undefined;
}

const ALERT_STYLES: Record<string, { label: string; border: string; text: string }> = {
  note: { label: 'Note', border: 'border-blue-500', text: 'text-blue-600 dark:text-blue-400' },
  tip: { label: 'Tip', border: 'border-green-500', text: 'text-green-600 dark:text-green-400' },
  important: {
    label: 'Important',
    border: 'border-purple-500',
    text: 'text-purple-600 dark:text-purple-400',
  },
  warning: {
    label: 'Warning',
    border: 'border-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
  },
  caution: { label: 'Caution', border: 'border-red-500', text: 'text-red-600 dark:text-red-400' },
};

/** GitHub alerts（> [!NOTE] 等）：摘掉标记文本，把类型标到 blockquote 的 data-alert */
function remarkGithubAlerts() {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node) => {
      const first = node.children[0];
      if (first?.type !== 'paragraph') return;
      const text = first.children[0];
      if (text?.type !== 'text') return;
      const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(text.value);
      if (!match) return;
      text.value = text.value.slice(match[0].length);
      // 标记后正文为空时去掉空 text 节点
      if (!text.value) first.children.shift();
      const kind = match[1].toLowerCase();
      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          'data-alert': kind,
          dataAlert: kind,
        },
      };
    });
  };
}

/** 仓库内文件路径判定（行内 code 渲染成 chip，聊天里点开 Files 面板，无链接上下文时复制）：需含目录分隔或 file.ext:line 形式 */
const FILE_PATH_RE =
  /^(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,8}(?::\d+(?:-\d+)?)?$|^[\w.-]+\.\w{1,8}:\d+(?:-\d+)?$/;

const REMARK_PLUGINS = [remarkGfm, remarkGithubAlerts];

/** 导出给 Files 面板 Markdown 预览复用（`filePreviewMarkdown.tsx`），聊天渲染路径不受影响 */
export const MarkdownCtx = createContext<{
  text: string;
  streaming: boolean;
  searchQuery: string;
  activeNth: number;
}>({ text: '', streaming: false, searchQuery: '', activeNth: -1 });

export interface MarkdownLinkContextValue {
  conversationId: string;
  projectId: string;
  /**
   * 当前会话实际 worktree；缺失时仍由 Main 校验相对路径。
   *
   * The current worktree for this conversation; Main still validates relative paths when absent.
   */
  cwd?: string;
}

/**
 * 本地聊天链接的权限上下文；Files 预览不提供它，保持原有外链行为。
 *
 * Authorization context for local chat links; Files preview omits it to preserve its existing external-link behavior.
 */
export const MarkdownLinkContext = createContext<MarkdownLinkContextValue | null>(null);

function revealErrorDescription(error: string, t: (key: string) => string): string {
  switch (error) {
    case 'invalid-path':
      return t('The link is outside the current workspace.');
    case 'unsupported':
      return t('This link is not available on the local computer.');
    case 'unavailable':
      return t('The linked file or folder is unavailable.');
    case 'unsupported-viewer':
      return t('This file format cannot be previewed inside EnsoCode.');
    case 'too-large':
      return t('The image is too large to preview.');
    case 'invalid-application':
      return t('The selected application path is invalid.');
    case 'application-unavailable':
      return t('VS Code is unavailable. Install it or select another application.');
    default:
      return error;
  }
}

async function openFileLinkContext(
  context: MarkdownLinkContextValue,
  file: string,
  itemId: string,
  t: (key: string) => string
): Promise<void> {
  try {
    const rel = toWorkspaceRelativePath(file, context.cwd);
    if (rel === null) throw new Error('invalid-path');
    const result = await window.electronAPI.workspaceFiles.openContext({
      conversationId: context.conversationId,
      projectId: context.projectId,
      rel,
      itemId,
    });
    if (!result.ok) throw new Error(result.error);
  } catch (error: unknown) {
    addToast({
      type: 'error',
      title: t('Could not open local file link'),
      description: revealErrorDescription(
        error instanceof Error ? error.message : String(error),
        t
      ),
    });
  }
}

function FileLinkContextMenu({
  context,
  file,
  extra,
  children,
}: {
  /** null = 工作区外，只显示 extra，不提供按设置打开 */
  context: MarkdownLinkContextValue | null;
  file: string;
  /** 固定菜单项，排在设置项之前 */
  extra?: ReactNode;
  children: ReactElement;
}) {
  const { t } = useI18n();
  const configured = useSettingsStore((state) => state.contextMenuOpen);
  const items = context ? configured.filter((item) => item.enabled) : [];
  if (items.length === 0 && !extra) return children;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} onContextMenu={(event) => event.stopPropagation()} />
      <ContextMenuPopup className="min-w-48">
        {extra}
        {items.map((item) => {
          const name =
            item.target === 'application'
              ? (item.applicationPath.split(/[/\\]/).at(-1) ?? item.applicationPath).replace(
                  /\.(?:exe|app)$/i,
                  ''
                )
              : 'VS Code';
          return (
            <ContextMenuItem
              key={item.id}
              closeOnClick
              onClick={() => context && void openFileLinkContext(context, file, item.id, t)}
            >
              {item.target === 'reveal' ? t(revealLabel()) : t('Open in {{app}}', { app: name })}
            </ContextMenuItem>
          );
        })}
      </ContextMenuPopup>
    </ContextMenu>
  );
}

/**
 * 行号只适用于带扩展名的本地文件，避免将 javascript:123 等协议误识别成路径。
 *
 * Line references apply only to local files with extensions, never protocols such as javascript:123.
 */
function classifyFileReference(href: string) {
  const classification = classifyMarkdownLink(href);
  if (classification.kind === 'external') return { classification, line: undefined };
  const reference = splitFileLineRef(classification.kind === 'local' ? classification.path : href);
  if (reference.line && /\.[\w]+$/.test(reference.path)) {
    return { classification: classifyMarkdownLink(reference.path), line: reference.line };
  }
  return { classification, line: undefined };
}

/** `[`path`](path)` 形式：链接只含一段 inline code 时取其文本，用于把定位按钮并入代码框 */
function soleInlineCodeText(node: unknown): string | null {
  const kids = (node as { children?: unknown[] } | undefined)?.children;
  if (kids?.length !== 1) return null;
  const code = kids[0] as { tagName?: string; children?: { type?: string; value?: unknown }[] };
  const text = code.tagName === 'code' && code.children?.length === 1 ? code.children[0] : null;
  return text?.type === 'text' && typeof text.value === 'string' ? text.value : null;
}

/** 本地文件打开/定位：Markdown 链接与气泡文件卡片共用；path 为 null 表示非本地链接 */
function useLocalFileOpen(path: string | null, line?: number) {
  const { t } = useI18n();
  const linkContext = useContext(MarkdownLinkContext);
  const [imagePreview, setImagePreview] = useState<{ rel: string; dataUrl: string } | null>(null);

  const fail = (error: string) => {
    addToast({
      type: 'error',
      title: t('Could not open local file link'),
      description: revealErrorDescription(error, t),
    });
  };

  const external =
    linkContext && path !== null ? toExternalAbsolutePath(path, linkContext.cwd) : null;

  /** 工作区外只定位不打开；用户在 Main 确认框里取消不提示 */
  const revealExternal = async (file: string) => {
    if (!linkContext) return;
    try {
      const result = await window.electronAPI.workspaceFiles.revealExternal({
        conversationId: linkContext.conversationId,
        projectId: linkContext.projectId,
        path: file,
      });
      if (!result.ok && result.error !== 'cancelled') fail(result.error);
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : String(error));
    }
  };

  const openLocal = async (reveal: boolean) => {
    if (!linkContext || path === null) return;
    const rel = toWorkspaceRelativePath(path, linkContext.cwd);
    if (rel == null) {
      if (external) await revealExternal(external);
      else fail('invalid-path');
      return;
    }
    if (!reveal && line) {
      openSidePanelFile(linkContext.conversationId, rel, line);
      return;
    }
    const req = {
      conversationId: linkContext.conversationId,
      projectId: linkContext.projectId,
      rel,
    };
    try {
      if (reveal) {
        const result = await window.electronAPI.workspaceFiles.reveal(req);
        if (!result.ok) fail(result.error);
        return;
      }
      const result = await window.electronAPI.workspaceFiles.open(req);
      if (!result.ok) {
        fail(result.error);
        return;
      }
      if (result.target === 'handled') return;
      if (result.viewer === 'image') {
        const mime = previewImageMime(result.rel);
        if (!mime) {
          fail('unsupported-viewer');
          return;
        }
        const image = await window.electronAPI.workspaceFiles.readImage({
          ...req,
          rel: result.rel,
        });
        if (!image.ok) {
          fail(image.error);
          return;
        }
        const prefix = `data:${mime};base64,`;
        if (
          !image.dataUrl.startsWith(prefix) ||
          !/^[A-Za-z0-9+/=]+$/.test(image.dataUrl.slice(prefix.length))
        ) {
          fail('unsupported-viewer');
          return;
        }
        setImagePreview({ rel: result.rel, dataUrl: image.dataUrl });
      } else if (result.viewer === 'markdown') {
        openSidePanelFile(linkContext.conversationId, result.rel, undefined, 'markdown');
      } else {
        openSidePanelFile(linkContext.conversationId, result.rel);
      }
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : String(error));
    }
  };

  const preview = (
    <WorkspaceImagePreview image={imagePreview} onClose={() => setImagePreview(null)} />
  );
  return { linkContext, external, openLocal, preview };
}

/**
 * 气泡里的 @文件 卡片：工作区内点击打开，右键固定提供「在文件夹中显示 / 复制路径」并追加设置项；
 * 工作区外不做越界授权，右键只提供复制路径（纯文本，不触达 Main）。
 */
export function LocalFileTrigger({ path, children }: { path: string; children: ReactElement }) {
  const { t } = useI18n();
  const revealConfigured = useSettingsStore((state) =>
    state.contextMenuOpen.some((item) => item.enabled && item.target === 'reveal')
  );
  const { classification } = classifyFileReference(path);
  const file = classification.kind === 'local' ? classification.path : null;
  const { linkContext, external, openLocal, preview } = useLocalFileOpen(file);
  const ssh = useSettingsStore((state) =>
    state.projects.some((item) => item.id === linkContext?.projectId && item.kind === 'ssh')
  );
  const inWorkspace =
    linkContext !== null &&
    file !== null &&
    toWorkspaceRelativePath(file, linkContext.cwd) !== null;
  const copyPath = () => {
    navigator.clipboard.writeText(file ?? path).then(
      () => addToast({ type: 'success', title: t('Copied') }),
      (error: unknown) =>
        addToast({
          type: 'error',
          title: t('Copy failed'),
          description: error instanceof Error ? error.message : String(error),
        })
    );
  };
  const extra = (
    <>
      {((inWorkspace && !revealConfigured) || (!inWorkspace && external)) && !ssh && (
        <ContextMenuItem closeOnClick onClick={() => void openLocal(true)}>
          {t(revealLabel())}
        </ContextMenuItem>
      )}
      <ContextMenuItem closeOnClick onClick={copyPath}>
        {t('Copy Path')}
      </ContextMenuItem>
    </>
  );
  if (!inWorkspace) {
    return (
      <FileLinkContextMenu context={null} file={file ?? path} extra={extra}>
        <span>{children}</span>
      </FileLinkContextMenu>
    );
  }
  return (
    <>
      <FileLinkContextMenu context={linkContext} file={file ?? path} extra={extra}>
        <span
          role="link"
          tabIndex={0}
          className="cursor-pointer"
          onClick={() => void openLocal(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void openLocal(false);
            }
          }}
        >
          {children}
        </span>
      </FileLinkContextMenu>
      {preview}
    </>
  );
}

function MarkdownAnchor({
  children,
  href,
  node,
}: {
  children?: ReactNode;
  href?: string;
  node?: unknown;
}) {
  const { t } = useI18n();
  const { classification, line } = classifyFileReference(href ?? '');
  const { linkContext, external, openLocal, preview } = useLocalFileOpen(
    classification.kind === 'local' ? classification.path : null,
    line
  );
  const local = classification.kind === 'local' && linkContext !== null;
  const codeText = local ? soleInlineCodeText(node) : null;

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (classification.kind === 'external') return;
    event.preventDefault();
    if (local) void openLocal(false);
  };

  const anchorElement = (
    <a
      href={classification.kind === 'external' ? href || undefined : undefined}
      className={cn(
        'text-brand underline decoration-brand/40 underline-offset-2 transition-colors hover:decoration-brand',
        local && 'cursor-pointer break-all'
      )}
      role={local ? 'link' : undefined}
      tabIndex={local ? 0 : undefined}
      {...(classification.kind === 'external' ? { target: '_blank', rel: 'noreferrer' } : {})}
      onClick={onClick}
      onKeyDown={(event) => {
        if (local && event.key === 'Enter') {
          event.preventDefault();
          void openLocal(false);
        }
      }}
    >
      {codeText ?? children}
    </a>
  );
  if (!local || classification.kind !== 'local' || !linkContext) return anchorElement;
  // 工作区外：菜单不提供按设置打开的应用，只保留定位
  const anchor = external ? (
    <FileLinkContextMenu
      context={null}
      file={classification.path}
      extra={
        <ContextMenuItem closeOnClick onClick={() => void openLocal(true)}>
          {t(revealLabel())}
        </ContextMenuItem>
      }
    >
      {anchorElement}
    </FileLinkContextMenu>
  ) : (
    <FileLinkContextMenu context={linkContext} file={classification.path}>
      {anchorElement}
    </FileLinkContextMenu>
  );

  if (codeText !== null) {
    return (
      <span className="inline-flex max-w-full items-center gap-0.5 rounded-[5px] border border-border/70 bg-muted/70 py-px pr-0.5 pl-1 align-baseline font-mono text-xs">
        {anchor}
        <button
          type="button"
          className="inline-flex shrink-0 rounded-[3px] p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
          aria-label={t(revealLabel())}
          title={t(revealLabel())}
          onClick={() => void openLocal(true)}
        >
          <FolderOpen className="h-3 w-3" />
        </button>
        {preview}
      </span>
    );
  }

  return (
    <span className="inline">
      {anchor}
      <button
        type="button"
        className="ml-1 inline-flex rounded p-0.5 align-middle text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={t(revealLabel())}
        title={t(revealLabel())}
        onClick={() => void openLocal(true)}
      >
        <FolderOpen className="h-3.5 w-3.5" />
      </button>
      {preview}
    </span>
  );
}

/**
 * 在保留 react-markdown 默认安全协议过滤的基础上，仅放行待点击的本地链接。
 *
 * Preserve react-markdown's default safe-protocol filter and only additionally allow local links that are handled on click.
 */
export function markdownUrlTransform(value: string, key?: string, allowLocal = true): string {
  const transformed = defaultUrlTransform(value);
  if (transformed || key !== 'href') return transformed;
  return allowLocal && classifyFileReference(value).classification.kind === 'local' ? value : '';
}

/** 模块级稳定引用：react-markdown 按组件类型协调子树，内联对象每帧都会拆掉 CodeBlock */
export const markdownComponents: Components = {
  p: ({ children }) => {
    const { searchQuery, activeNth } = useContext(MarkdownCtx);
    return (
      <p className="my-2 leading-[1.7] first:mt-0 last:mb-0">
        {searchQuery.trim() ? highlightNode(children, searchQuery, activeNth, { n: 0 }) : children}
      </p>
    );
  },
  a: MarkdownAnchor,
  ul: ({ children }) => (
    <ul className="my-2 list-disc pl-5 space-y-1 marker:text-muted-foreground">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal pl-5 space-y-1 marker:text-muted-foreground">{children}</ol>
  ),
  h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-base font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1 text-sm font-semibold">{children}</h3>,
  blockquote: ({ children, node }) => {
    const { t } = useI18n();
    const props = node?.properties as Record<string, unknown> | undefined;
    const kind = String(props?.dataAlert ?? props?.['data-alert'] ?? '');
    const alert = ALERT_STYLES[kind];
    if (alert) {
      return (
        <blockquote className={cn('my-1.5 border-l-2 pl-3', alert.border)}>
          <p className={cn('mt-1.5 mb-0.5 text-xs font-semibold', alert.text)}>{t(alert.label)}</p>
          {children}
        </blockquote>
      );
    }
    return (
      <blockquote className="my-2 border-l-2 border-brand/30 pl-3 text-muted-foreground">
        {children}
      </blockquote>
    );
  },
  code: ({ children }) => {
    const { t } = useI18n();
    const linkContext = useContext(MarkdownLinkContext);
    const value = typeof children === 'string' ? children : '';
    if (value && FILE_PATH_RE.test(value)) {
      const { path, line } = splitFileLineRef(value);
      const onClick = () => {
        if (!linkContext) {
          void navigator.clipboard.writeText(path);
          return;
        }
        const rel = toWorkspaceRelativePath(path, linkContext.cwd);
        if (!rel) {
          addToast({
            type: 'error',
            title: t('Could not open local file link'),
            description: t('The link is outside the current workspace.'),
          });
          return;
        }
        openSidePanelFile(linkContext.conversationId, rel, line);
      };
      const chip = (
        <button
          type="button"
          onClick={onClick}
          title={value}
          className="inline-flex max-w-full items-center rounded-[5px] border border-border/70 bg-muted/70 px-1 py-px align-baseline font-mono text-xs text-brand transition-colors hover:bg-muted"
        >
          <span className="truncate">{value}</span>
        </button>
      );
      return linkContext ? (
        <FileLinkContextMenu context={linkContext} file={path}>
          {chip}
        </FileLinkContextMenu>
      ) : (
        chip
      );
    }
    return (
      <code className="rounded-[5px] border border-border/70 bg-muted/70 px-1 py-px font-mono text-xs">
        {children}
      </code>
    );
  },
  pre: ({ node }) => {
    const { streaming } = useContext(MarkdownCtx);
    const codeNode = node?.children?.[0];
    const props =
      codeNode && 'properties' in codeNode
        ? (codeNode.properties as { className?: string[] })
        : undefined;
    const info = /language-(\S+)/.exec(props?.className?.join(' ') ?? '')?.[1];
    const textNode = codeNode && 'children' in codeNode ? codeNode.children?.[0] : undefined;
    const raw = textNode && 'value' in textNode ? String(textNode.value) : '';
    const source = raw.replace(/\n$/, '');
    const language = parseFenceLang(info);
    if (language?.toLowerCase() === 'mermaid') {
      return <MermaidRenderer code={source} streaming={streaming} />;
    }
    return <CodeBlock code={source} language={language} streaming={streaming} />;
  },
  table: ({ children, node }) => {
    const { text, streaming } = useContext(MarkdownCtx);
    const start = node?.position?.start?.offset;
    const end = node?.position?.end?.offset;
    const raw = start !== undefined && end !== undefined ? text.slice(start, end) : null;
    return (
      <div className="group/table relative my-2 min-w-0 max-w-full overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
        <table className="w-max min-w-full border-collapse text-xs [overflow-wrap:normal]">
          {children}
        </table>
        {raw && !streaming && (
          <CopyButton
            text={raw}
            className="absolute top-0.5 right-0.5 rounded-md border bg-background/80 p-1.5 text-muted-foreground opacity-0 backdrop-blur transition-opacity group-hover/table:opacity-100"
          />
        )}
      </div>
    );
  },
  th: ({ children }) => (
    <th className="whitespace-nowrap border-b border-border px-2 py-1 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="whitespace-nowrap border-b border-border/50 px-2 py-1">{children}</td>
  ),
  hr: () => <hr className="my-3 border-border" />,
};

/** assistant 正文的 markdown 渲染，样式内联为 Tailwind（项目未引入 typography 插件） */
export function Markdown({
  text,
  streaming = false,
  searchQuery = '',
  activeNth = -1,
}: {
  text: string;
  streaming?: boolean;
  searchQuery?: string;
  activeNth?: number;
}) {
  const linkContext = useContext(MarkdownLinkContext);
  const allowLocalMarkdownLinks = linkContext !== null;
  const ctx = useMemo(
    () => ({ text, streaming, searchQuery, activeNth }),
    [text, streaming, searchQuery, activeNth]
  );
  const urlTransform = useMemo(
    () => (value: string, key: string) => markdownUrlTransform(value, key, allowLocalMarkdownLinks),
    [allowLocalMarkdownLinks]
  );
  return (
    <MarkdownCtx.Provider value={ctx}>
      <div className={streaming ? 't-stream-live' : undefined}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          components={markdownComponents}
          urlTransform={urlTransform}
        >
          {text}
        </ReactMarkdown>
      </div>
    </MarkdownCtx.Provider>
  );
}
