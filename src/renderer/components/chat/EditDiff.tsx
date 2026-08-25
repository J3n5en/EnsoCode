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

/** 主题跟随系统深浅色，split 左右分栏 + 词级高亮，纯 JS 高亮器（免 WASM，适配 electron-vite） */
const DIFF_OPTIONS = {
  themeType: 'system',
  theme: { dark: 'github-dark', light: 'github-light' },
  diffStyle: 'split',
  lineDiffType: 'word',
  disableFileHeader: true,
  preferredHighlighter: 'shiki-js',
} as const;

/**
 * 从当前文件内容反向套用 edits 还原编辑前内容。
 * 逆序 undo（newText→oldText）；任一块在当前内容里找不到就放弃（可能被后续编辑改动过）。
 */
function reconstructOld(current: string, blocks: EditBlock[]): string | null {
  let text = current;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const { oldText, newText } = blocks[i];
    const idx = text.indexOf(newText);
    if (idx === -1) return null;
    text = text.slice(0, idx) + oldText + text.slice(idx + newText.length);
  }
  return text;
}

type Loaded =
  | { kind: 'loading' }
  | { kind: 'full'; oldText: string; newText: string }
  | { kind: 'blocks' };

/** 用 @pierre/diffs 渲染 edit 工具的改动：优先读实际文件给出真实行号+上下文，否则回退片段 diff */
export function EditDiff({ path, blocks }: { path: string; blocks: EditBlock[] }) {
  const name = path.split('/').pop() || 'file';
  const [state, setState] = useState<Loaded>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    Promise.all([
      preloadHighlighter({
        themes: [...THEMES],
        langs: [...LANGS],
        preferredHighlighter: 'shiki-js',
      }).catch(() => {}),
      window.electronAPI.files.read(path),
    ]).then(([, current]) => {
      if (!alive) return;
      const old = current != null ? reconstructOld(current, blocks) : null;
      setState(
        old != null && current != null
          ? { kind: 'full', oldText: old, newText: current }
          : { kind: 'blocks' }
      );
    });
    return () => {
      alive = false;
    };
  }, [path, blocks]);

  if (state.kind === 'loading') {
    return (
      <div className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
        加载 diff…
      </div>
    );
  }

  return (
    <div className="border-t border-border/60 text-xs">
      {state.kind === 'full' ? (
        <DiffView name={name} oldText={state.oldText} newText={state.newText} />
      ) : (
        // 读不到文件时的兜底：每个替换块单独一段片段 diff（无真实行号/上下文）
        blocks.map((block, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: edits 随消息整体快照替换，无独立 id
          <DiffView key={index} name={name} oldText={block.oldText} newText={block.newText} />
        ))
      )}
    </div>
  );
}

function DiffView({ name, oldText, newText }: { name: string; oldText: string; newText: string }) {
  const fileDiff = useMemo(
    () => parseDiffFromFile({ name, contents: oldText }, { name, contents: newText }),
    [name, oldText, newText]
  );
  return <FileDiff fileDiff={fileDiff} disableWorkerPool options={DIFF_OPTIONS} />;
}
