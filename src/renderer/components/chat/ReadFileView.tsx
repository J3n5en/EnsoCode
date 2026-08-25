import { File } from '@pierre/diffs/react';
import { Code, Eye } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/i18n';
import { CODE_THEME, ensureHighlighter } from './codeHighlighter';
import { Markdown } from './Markdown';

const FILE_OPTIONS = {
  themeType: 'system',
  theme: CODE_THEME,
  disableFileHeader: true,
  overflow: 'wrap',
  preferredHighlighter: 'shiki-js',
} as const;

const isMarkdownPath = (path: string): boolean => /\.(md|markdown)$/i.test(path);

/** read 工具输出：md 默认渲染（可切源码），其余按文件名推断语言做语法高亮 + 行号 */
export function ReadFileView({ path, contents }: { path: string; contents: string }) {
  const { t } = useI18n();
  const isMarkdown = isMarkdownPath(path);
  const [showSource, setShowSource] = useState(false);

  if (isMarkdown) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          className="absolute top-1.5 right-1.5 z-10 rounded-md border bg-background/80 p-1.5 text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
          title={showSource ? t('Show rendered') : t('Show source')}
        >
          {showSource ? <Eye className="h-3.5 w-3.5" /> : <Code className="h-3.5 w-3.5" />}
        </button>
        {showSource ? (
          <HighlightedFile path={path} contents={contents} />
        ) : (
          <div className="px-3 py-2 text-sm">
            <Markdown text={contents} />
          </div>
        )}
      </div>
    );
  }
  return <HighlightedFile path={path} contents={contents} />;
}

function HighlightedFile({ path, contents }: { path: string; contents: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    ensureHighlighter().then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const file = useMemo(
    () => ({ name: path.split('/').pop() || 'file', contents }),
    [path, contents]
  );

  if (!ready) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">加载中…</div>;
  }
  return <File file={file} disableWorkerPool options={FILE_OPTIONS} />;
}
