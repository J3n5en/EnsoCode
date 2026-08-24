import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** assistant 正文的 markdown 渲染，样式内联为 Tailwind（项目未引入 typography 插件） */
export function Markdown({ text }: { text: string }) {
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
        code: ({ children, className }) =>
          className ? (
            <code className={`${className} font-mono text-xs`}>{children}</code>
          ) : (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>
          ),
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs leading-relaxed">
            {children}
          </pre>
        ),
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
