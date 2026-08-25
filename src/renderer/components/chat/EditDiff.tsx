import { parseDiffFromFile, preloadHighlighter } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { useEffect, useMemo, useState } from 'react';
import type { EditBlock } from '@/stores/sessions/timeline';

const THEMES = ['github-dark', 'github-light'] as const;
/** 预热覆盖常见源码类型；未列出的语言回退纯文本 */
const LANGS = [
  'markdown',
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'css',
  'html',
  'python',
  'rust',
  'go',
  'shellscript',
  'yaml',
  'text',
] as const;

/** 主题跟随系统深浅色，unified 视图 + 词级高亮，纯 JS 高亮器（免 WASM，适配 electron-vite） */
const DIFF_OPTIONS = {
  themeType: 'system',
  theme: { dark: 'github-dark', light: 'github-light' },
  diffStyle: 'unified',
  lineDiffType: 'word',
  disableFileHeader: true,
  disableLineNumbers: true,
  overflow: 'wrap',
  preferredHighlighter: 'shiki-js',
} as const;

/** 用 @pierre/diffs 渲染 edit 工具的替换块（每块一段 old→new 迷你文件 diff） */
export function EditDiff({ path, blocks }: { path: string; blocks: EditBlock[] }) {
  const name = path.split('/').pop() || 'file';
  const [ready, setReady] = useState(false);

  // Shiki 高亮器一次性预热；失败也放行（回退无高亮）
  useEffect(() => {
    let alive = true;
    preloadHighlighter({
      themes: [...THEMES],
      langs: [...LANGS],
      preferredHighlighter: 'shiki-js',
    })
      .catch(() => {})
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!ready) {
    return (
      <div className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
        加载 diff…
      </div>
    );
  }

  return (
    <div className="border-t border-border/60 text-xs">
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: edits 随消息整体快照替换，无独立 id
        <DiffOne key={index} name={name} block={block} />
      ))}
    </div>
  );
}

function DiffOne({ name, block }: { name: string; block: EditBlock }) {
  const fileDiff = useMemo(
    () => parseDiffFromFile({ name, contents: block.oldText }, { name, contents: block.newText }),
    [name, block]
  );
  return <FileDiff fileDiff={fileDiff} disableWorkerPool options={DIFF_OPTIONS} />;
}
