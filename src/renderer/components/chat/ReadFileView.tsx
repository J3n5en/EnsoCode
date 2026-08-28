import { File } from '@pierre/diffs/react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/i18n';
import { CODE_THEME, ensureHighlighter } from './codeHighlighter';

const FILE_OPTIONS = {
  themeType: 'system',
  theme: CODE_THEME,
  disableFileHeader: true,
  overflow: 'wrap',
  preferredHighlighter: 'shiki-js',
} as const;

/** read 工具输出：按文件名推断语言做语法高亮 + 行号渲染 */
export function ReadFileView({ path, contents }: { path: string; contents: string }) {
  const { t } = useI18n();
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
    return <div className="px-3 py-2 text-xs text-muted-foreground">{t('Loading...')}</div>;
  }
  return <File file={file} disableWorkerPool options={FILE_OPTIONS} />;
}
