import type { Root } from 'mdast';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import { cn } from '@/lib/utils';
import { CodeBlock } from './CodeBlock';
import { CopyButton } from './CopyButton';
import { MermaidRenderer } from './MermaidRenderer';

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
      node.data = {
        ...node.data,
        hProperties: { ...node.data?.hProperties, 'data-alert': match[1].toLowerCase() },
      };
    });
  };
}

/** 仓库内文件路径判定（行内 code 渲染成可复制 chip）：需含目录分隔或 file.ext:line 形式 */
const FILE_PATH_RE =
  /^(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,8}(?::\d+(?:-\d+)?)?$|^[\w.-]+\.\w{1,8}:\d+(?:-\d+)?$/;

/** assistant 正文的 markdown 渲染，样式内联为 Tailwind（项目未引入 typography 插件） */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkGithubAlerts]}
      components={{
        p: ({ children }) => (
          <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>
        ),
        a: ({ children, href }) => (
          <a
            href={href}
            className="text-primary underline underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="my-1.5 list-disc pl-5 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5 space-y-0.5">{children}</ol>,
        h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-base font-semibold">{children}</h1>,
        h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-base font-semibold">{children}</h2>,
        h3: ({ children }) => <h3 className="mt-2 mb-1 text-sm font-semibold">{children}</h3>,
        blockquote: ({ children, node }) => {
          const alert = ALERT_STYLES[String(node?.properties?.dataAlert ?? '')];
          if (alert) {
            return (
              <blockquote className={cn('my-1.5 border-l-2 pl-3', alert.border)}>
                <p className={cn('mt-1.5 mb-0.5 text-xs font-semibold', alert.text)}>
                  {alert.label}
                </p>
                {children}
              </blockquote>
            );
          }
          return (
            <blockquote className="my-1.5 border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          );
        },
        // 行内 code：文件路径渲染成可复制 chip，其余保持 pill 样式
        code: ({ children }) => {
          const value = typeof children === 'string' ? children : '';
          if (value && FILE_PATH_RE.test(value)) {
            return (
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(value.split(':')[0])}
                title={value}
                className="inline-flex max-w-full items-center rounded border bg-muted px-1 py-0.5 align-baseline font-mono text-xs text-primary transition-colors hover:bg-muted/70"
              >
                <span className="truncate">{value}</span>
              </button>
            );
          }
          return <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>;
        },
        // 块级代码交给 shiki 高亮（含单行缩进块）；语言取自 ```lang 标记，无标记按纯文本
        pre: ({ node }) => {
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
          // 按 mdast position 从原文切出表格 markdown，hover 提供复制
          const start = node?.position?.start?.offset;
          const end = node?.position?.end?.offset;
          const raw = start !== undefined && end !== undefined ? text.slice(start, end) : null;
          return (
            <div className="group/table relative my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
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
          <th className="border-b border-border px-2 py-1 text-left font-medium">{children}</th>
        ),
        td: ({ children }) => <td className="border-b border-border/50 px-2 py-1">{children}</td>,
        hr: () => <hr className="my-3 border-border" />,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
