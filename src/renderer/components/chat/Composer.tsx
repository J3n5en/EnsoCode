import type { AttachedImage, SlashCommand } from '@shared/types/agent';
import { ArrowUp, CircleStop, FileText, SlashSquare, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface FileHit {
  relativePath: string;
  name: string;
}

interface ComposerProps {
  /** 文件搜索根目录；无项目时禁用 @ */
  cwd?: string;
  /** 会话可用斜杠命令（spawn 后由 worker 上报） */
  commands: SlashCommand[];
  running: boolean;
  busy: boolean;
  /** 会话 id：变化（新建/切换会话）时自动 focus 输入框 */
  focusKey?: string;
  /** 底部工具行左侧插槽（模型选择器等） */
  toolbar?: React.ReactNode;
  /** 有待处理审批时锁定输入（ref-chat-a 语义：先处理审批再继续） */
  locked?: boolean;
  onSend: (text: string, images: AttachedImage[]) => void;
  onAbort: () => void;
}

/** 光标前最近一个 @ 到光标的片段；遇空白断开则不在提及中 */
function extractMentionQuery(text: string, cursor: number): string | null {
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '@') return text.slice(i + 1, cursor);
    if (ch === ' ' || ch === '\n') return null;
  }
  return null;
}

/** 光标前最近一个 / 的位置；仅当 / 位于 token 起始（行首或空白后）才算命令 */
function findSlashStart(text: string, cursor: number): number | null {
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '/') {
      const prev = i > 0 ? text[i - 1] : ' ';
      return prev === ' ' || prev === '\n' ? i : null;
    }
    if (ch === ' ' || ch === '\n') return null;
  }
  return null;
}

/** 各会话未发送的输入草稿（切会话时暂存/恢复;仅内存,不持久化） */
const drafts = new Map<string, { text: string; images: AttachedImage[] }>();

export function Composer({
  cwd,
  commands,
  running,
  busy,
  focusKey,
  toolbar,
  locked = false,
  onSend,
  onAbort,
}: ComposerProps) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const prevFocusKeyRef = useRef(focusKey);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<FileHit[]>([]);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // 切换会话（focusKey 变化）:保存旧会话草稿、恢复新会话草稿（未发送内容不串会话、切回不丢），并聚焦
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey 是触发信号，text/images 取切换瞬间的旧值
  useEffect(() => {
    const previous = prevFocusKeyRef.current;
    if (previous !== focusKey) {
      if (previous) drafts.set(previous, { text, images });
      const draft = focusKey ? drafts.get(focusKey) : undefined;
      setText(draft?.text ?? '');
      setImages(draft?.images ?? []);
      prevFocusKeyRef.current = focusKey;
    }
    textareaRef.current?.focus();
  }, [focusKey]);

  const slashResults =
    slashQuery === null
      ? []
      : commands
          .filter((command) => command.name.toLowerCase().includes(slashQuery.toLowerCase()))
          .slice(0, 10);

  const detect = useCallback(
    (value: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      // 等 React 写回 value 后再读光标位置
      setTimeout(() => {
        const cursor = ta.selectionStart;
        const mention = cwd ? extractMentionQuery(value, cursor) : null;
        setMentionQuery(mention);
        const slashStart = mention === null ? findSlashStart(value, cursor) : null;
        setSlashQuery(slashStart === null ? null : value.slice(slashStart + 1, cursor));
        setActiveIndex(0);
      }, 0);
    },
    [cwd]
  );

  // @ 文件搜索（防抖）
  useEffect(() => {
    if (mentionQuery === null || !cwd) {
      setMentionResults([]);
      return;
    }
    const timer = setTimeout(() => {
      window.electronAPI.files
        .search(cwd, mentionQuery)
        .then(setMentionResults)
        .catch(() => setMentionResults([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [mentionQuery, cwd]);

  useEffect(() => {
    const item = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  /** 用 replacement 替换光标前的触发 token（@query 或 /query） */
  const replaceToken = useCallback(
    (trigger: '@' | '/', replacement: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const cursor = ta.selectionStart;
      let start = -1;
      for (let i = cursor - 1; i >= 0; i--) {
        if (text[i] === trigger) {
          start = i;
          break;
        }
        if (text[i] === ' ' || text[i] === '\n') break;
      }
      if (start === -1) return;
      const next = text.slice(0, start) + replacement + text.slice(cursor);
      setText(next);
      setMentionQuery(null);
      setSlashQuery(null);
      const newCursor = start + replacement.length;
      setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(newCursor, newCursor);
      }, 0);
    },
    [text]
  );

  const popup:
    | { kind: 'mention'; items: FileHit[] }
    | { kind: 'slash'; items: SlashCommand[] }
    | null =
    mentionQuery !== null && mentionResults.length > 0
      ? { kind: 'mention', items: mentionResults }
      : slashQuery !== null && slashResults.length > 0
        ? { kind: 'slash', items: slashResults }
        : null;

  const pick = useCallback(
    (index: number) => {
      if (!popup) return;
      if (popup.kind === 'mention') {
        replaceToken('@', `@${popup.items[index].relativePath} `);
      } else {
        replaceToken('/', `${popup.items[index].name} `);
      }
    },
    [popup, replaceToken]
  );

  const handleSend = () => {
    const content = text.trim();
    if (!content && images.length === 0) return;
    setText('');
    setImages([]);
    setMentionQuery(null);
    setSlashQuery(null);
    onSend(content, images);
  };

  /** 在光标处插入文本片段 */
  const insertAtCursor = useCallback(
    (snippet: string) => {
      const ta = textareaRef.current;
      const cursor = ta ? ta.selectionStart : text.length;
      const next = text.slice(0, cursor) + snippet + text.slice(cursor);
      setText(next);
      const newCursor = cursor + snippet.length;
      setTimeout(() => {
        ta?.focus();
        ta?.setSelectionRange(newCursor, newCursor);
      }, 0);
    },
    [text]
  );

  /** 粘贴/拖入的文件统一处理：图片转 base64 附件，其余插入磁盘路径 */
  const ingestFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
            setImages((prev) => [...prev, { data: base64, mimeType: file.type }]);
          };
          reader.readAsDataURL(file);
        } else {
          // 非图片文件：插入磁盘路径，agent 用 read 工具读取
          const filePath = window.electronAPI.files.pathForFile(file);
          if (filePath) insertAtCursor(`@${filePath} `);
        }
      }
    },
    [insertAtCursor]
  );

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    e.preventDefault();
    ingestFiles(files);
  };

  const handleDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    e.preventDefault();
    setDragging(false);
    ingestFiles(files);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (popup) {
      const total = popup.items.length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % total);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + total) % total);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(activeIndex);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        setSlashQuery(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="relative">
      {popup && (
        <div
          ref={listRef}
          className="absolute bottom-full left-0 z-10 mb-1.5 max-h-64 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
        >
          {popup.kind === 'mention'
            ? popup.items.map((item, index) => (
                <button
                  key={item.relativePath}
                  type="button"
                  onClick={() => pick(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                    index === activeIndex && 'bg-muted'
                  )}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 font-medium">{item.name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {item.relativePath}
                  </span>
                </button>
              ))
            : popup.items.map((item, index) => (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => pick(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                    index === activeIndex && 'bg-muted'
                  )}
                >
                  <SlashSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 font-mono font-medium">{item.name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {item.description}
                  </span>
                </button>
              ))}
        </div>
      )}

      <div
        className={cn(
          'rounded-xl border bg-background shadow-sm transition-colors focus-within:border-ring',
          dragging && 'border-ring bg-muted/30'
        )}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={handleDrop}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((image, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 附件无稳定 id，增删都整组重渲染
              <div key={index} className="group relative">
                <img
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt=""
                  className="h-16 w-16 rounded-md border object-cover"
                />
                <button
                  type="button"
                  onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                  className="absolute -top-1.5 -right-1.5 rounded-full border bg-background p-0.5 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-destructive group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            detect(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionEnd={(e) => detect((e.target as HTMLTextAreaElement).value)}
          placeholder={
            locked
              ? t('Resolve the pending approval to continue')
              : running
                ? t('Message will queue until this round finishes…')
                : t('Ask the agent…')
          }
          disabled={locked}
          rows={2}
          className="max-h-40 w-full resize-none bg-transparent px-3.5 pt-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between gap-1.5 px-1.5 pb-1">
          <div className="flex min-w-0 items-center gap-1">{toolbar}</div>
          {busy ? (
            <Button variant="outline" size="icon" className="h-7 w-7 rounded-lg" onClick={onAbort}>
              <CircleStop className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="h-7 w-7 rounded-lg"
              onClick={handleSend}
              disabled={!text.trim() && images.length === 0}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
