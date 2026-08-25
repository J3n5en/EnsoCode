import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';

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

/** assistant 正文的 markdown 渲染，样式内联为 Tailwind（项目未引入 typography 插件） */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
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
        blockquote: ({ children }) => (
          <blockquote className="my-1.5 border-l-2 border-border pl-3 text-muted-foreground">
            {children}
          </blockquote>
        ),
        // 行内 code 的 pill 样式；块级 code 由下面的 pre 渲染器接管（用 hast node 取原文）
        code: ({ children }) => (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>
        ),
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
          return (
            <CodeBlock
              code={raw.replace(/\n$/, '')}
              language={parseFenceLang(info)}
              streaming={streaming}
            />
          );
        },
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
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
