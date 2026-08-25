import { useEffect, useState } from 'react';
import { codeToHtml } from './snippetHighlighter';

/** 无语言标记时的轻量猜测（缩进代码块常见）；猜错也只是配色不同 */
function guessLanguage(code: string): string {
  const head = code.trimStart();
  if (/^<[a-zA-Z!/]/.test(head)) return 'html';
  if (/^[{[]/.test(head)) return 'json';
  if (/^[$#] /.test(head)) return 'shellscript';
  return 'text';
}

/** markdown 代码块的语法高亮；语言取自 ```lang 标记，未标记做轻量猜测 */
export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    codeToHtml(code, language ?? guessLanguage(code)).then((out) => {
      if (alive) setHtml(out);
    });
    return () => {
      alive = false;
    };
  }, [code, language]);

  if (html == null) {
    return (
      <pre className="my-2 overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <div
      className="my-2 overflow-x-auto rounded-md border text-xs leading-relaxed [&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:p-3 [&_pre]:font-mono"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 输出的受控 HTML（本地生成，无用户注入）
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
