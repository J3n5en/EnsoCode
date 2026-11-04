import { useEffect, useState } from 'react';
import { CopyButton } from './CopyButton';
import { codeToHtml } from './snippetHighlighter';

/**
 * sunken 底由外层画：shiki 在 pre 上内联浅色底、深色走 --shiki-dark-bg，两者都要压成透明。
 * 手机 PWA 没有 sunken token，回落到 muted。
 */
const CODE_SURFACE =
  'my-2 overflow-x-auto rounded-lg border bg-[var(--sunken,var(--muted))] text-xs leading-relaxed';

/** 无语言标记时的轻量猜测（缩进代码块常见）；猜错也只是配色不同 */
function guessLanguage(code: string): string {
  const head = code.trimStart();
  if (/^<[a-zA-Z!/]/.test(head)) return 'html';
  if (/^[{[]/.test(head)) return 'json';
  if (/^[$#] /.test(head)) return 'shellscript';
  return 'text';
}

/** markdown 代码块的语法高亮；语言取自 ```lang 标记，未标记做轻量猜测 */
export function CodeBlock({
  code,
  language,
  streaming = false,
}: {
  code: string;
  language?: string;
  /** 流式中内容还在变，不写高亮缓存、不显示复制按钮 */
  streaming?: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (streaming) {
      setHtml(null);
      return;
    }
    let alive = true;
    codeToHtml(code, language ?? guessLanguage(code), true).then((out) => {
      if (alive) setHtml(out);
    });
    return () => {
      alive = false;
    };
  }, [code, language, streaming]);

  const copy = !streaming && (
    <CopyButton
      text={code}
      className="absolute top-1.5 right-1.5 rounded-md border bg-background/80 p-1.5 text-muted-foreground opacity-0 backdrop-blur transition-opacity group-hover/code:opacity-100"
    />
  );

  if (html == null) {
    return (
      <div data-enso="code-block" className="group/code relative">
        <pre className={`${CODE_SURFACE} p-3 font-mono`}>
          <code>{code}</code>
        </pre>
        {copy}
      </div>
    );
  }
  return (
    <div data-enso="code-block" className="group/code relative">
      <div
        className={`${CODE_SURFACE} [&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:bg-transparent! [&_pre]:p-3 [&_pre]:font-mono [&_pre]:[--shiki-dark-bg:transparent]!`}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 输出的受控 HTML（本地生成，无用户注入）
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {copy}
    </div>
  );
}
