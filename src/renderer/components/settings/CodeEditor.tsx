import { Editor, type EditorOptions } from '@pierre/diffs/edit';
import { EditProvider, File, Virtualizer } from '@pierre/diffs/react';
import * as React from 'react';
import { CODE_THEME, ensureHighlighter } from '@/components/chat/codeHighlighter';
import { useCodeHighlightOptions } from '@/hooks/useColorScheme';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { SettingsPreview } from './kit';

const FILE_OPTIONS = {
  theme: CODE_THEME,
  disableFileHeader: true,
  overflow: 'scroll',
  preferredHighlighter: 'shiki-js',
} as const;

function createEditor<A>(options: EditorOptions<A>) {
  return new Editor(options);
}

/** 带高亮的代码编辑框；语言按 fileName 扩展名推断，epoch 变化时以 value 重置内容 */
export function CodeEditor({
  fileName,
  value,
  epoch,
  onChange,
  className = 'h-60',
}: {
  fileName: string;
  value: string;
  epoch: number | string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const [ready, setReady] = React.useState(false);
  const options = useCodeHighlightOptions(FILE_OPTIONS);
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const editOptions = React.useMemo<EditorOptions<undefined>>(
    () => ({
      onChange(file) {
        onChangeRef.current(file.contents);
      },
    }),
    []
  );

  React.useEffect(() => {
    let alive = true;
    void ensureHighlighter().then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!ready) {
    return (
      <SettingsPreview
        className={cn(
          'flex w-full items-center justify-center text-muted-foreground text-xs',
          className
        )}
      >
        {t('Loading...')}
      </SettingsPreview>
    );
  }

  return (
    <SettingsPreview data-code-editor="" className={cn('w-full overflow-hidden', className)}>
      <EditProvider createEditor={createEditor}>
        <Virtualizer style={{ height: '100%', overflow: 'auto' }}>
          <File
            key={epoch}
            file={{ name: fileName, contents: value }}
            disableWorkerPool
            edit
            editorOptions={editOptions}
            options={options}
          />
        </Virtualizer>
      </EditProvider>
    </SettingsPreview>
  );
}
