import { parseDiffFromFile } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/i18n';
import { reconstructOld } from '@/lib/sessionChanges';
import type { EditBlock } from '@/stores/sessions/timeline';
import { CODE_THEME, ensureHighlighter } from './codeHighlighter';

/** 主题跟随系统深浅色，split 左右分栏 + 词级高亮，纯 JS 高亮器（免 WASM，适配 electron-vite） */
const DIFF_OPTIONS = {
  themeType: 'system',
  theme: CODE_THEME,
  diffStyle: 'split',
  lineDiffType: 'word',
  disableFileHeader: true,
  preferredHighlighter: 'shiki-js',
  // 聊天窄栏内长行必须换行:默认横向溢出会冲出卡片,且行尾的改动完全不可见
  overflow: 'wrap',
} as const;

type Loaded =
  | { kind: 'loading' }
  | { kind: 'full'; oldText: string; newText: string }
  | { kind: 'blocks' };

/** 用 @pierre/diffs 渲染 edit 工具的改动：优先读实际文件给出真实行号+上下文，否则回退片段 diff */
export function EditDiff({ path, blocks }: { path: string; blocks: EditBlock[] }) {
  const { t } = useI18n();
  const name = path.split('/').pop() || 'file';
  const [state, setState] = useState<Loaded>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    Promise.all([ensureHighlighter(), window.electronAPI.files.read(path)])
      .then(([, current]) => {
        if (!alive) return;
        // 读不到（手机端无本机文件系统）或还原失败时退成片段 diff
        const old = typeof current === 'string' ? reconstructOld(current, blocks) : null;
        setState(
          old != null && typeof current === 'string'
            ? { kind: 'full', oldText: old, newText: current }
            : { kind: 'blocks' }
        );
      })
      // 没有这个兜底，任何一步抛错都会让链断掉、永远停在「加载 diff…」
      .catch(() => {
        if (alive) setState({ kind: 'blocks' });
      });
    return () => {
      alive = false;
    };
  }, [path, blocks]);

  if (state.kind === 'loading') {
    return (
      <div className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
        {t('Loading diff…')}
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
