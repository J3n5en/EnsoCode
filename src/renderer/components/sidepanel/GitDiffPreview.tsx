import { CodeView } from '@pierre/diffs/react';
import type { GitFileDiffResult } from '@shared/types/git';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CODE_THEME, ensureHighlighter } from '@/components/chat/codeHighlighter';
import { useCodeHighlightOptions } from '@/hooks/useColorScheme';
import { useI18n } from '@/i18n';
import { buildChangeItems, type ChangeItemMemo } from '@/lib/changesItems';

const OPTIONS = {
  theme: CODE_THEME,
  diffStyle: 'split',
  lineDiffType: 'word',
  preferredHighlighter: 'shiki-js',
  overflow: 'scroll',
  stickyHeaders: true,
} as const;
const STYLE = { height: '100%', overflow: 'auto' } as const;
const EXPANDED = new Set<string>();

export function GitDiffPreview({
  result,
  loading,
}: {
  result: GitFileDiffResult | null;
  loading: boolean;
}) {
  const { t } = useI18n();
  const options = useCodeHighlightOptions(OPTIONS);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const memo = useRef<ChangeItemMemo>(new Map());
  useEffect(() => {
    let alive = true;
    void ensureHighlighter().then(
      () => {
        if (alive) setReady(true);
      },
      () => {
        if (alive) setFailed(true);
      }
    );
    return () => {
      alive = false;
    };
  }, []);
  const items = useMemo(
    () =>
      buildChangeItems(result?.ok ? [result] : [], EXPANDED, memo.current, {
        ignoreLineEndings: true,
      }),
    [result]
  );
  const message = loading
    ? t('Loading...')
    : failed
      ? t('Could not load the diff viewer.')
      : !result
        ? t('Select a file to view its diff.')
        : !result.ok
          ? t(result.error)
          : !ready
            ? t('Loading...')
            : result.oldText === result.newText
              ? t('No text changes to display.')
              : items[0]?.fileDiff.hunks.length === 0
                ? t('Only line endings changed.')
                : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {message ? (
        <div
          className="flex h-full items-center justify-center px-4 py-8 text-center text-xs text-muted-foreground"
          role="status"
        >
          {message}
        </div>
      ) : (
        <CodeView className="min-h-0 w-full flex-1" items={items} style={STYLE} options={options} />
      )}
    </div>
  );
}
