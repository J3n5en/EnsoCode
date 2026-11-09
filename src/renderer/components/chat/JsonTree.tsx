import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { CodeBlock } from './CodeBlock';
import { CopyButton } from './CopyButton';

/** 默认展开的层数：再深的节点折叠，只显示条目数 */
const OPEN_DEPTH = 2;

function Primitive({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    return <span className="text-emerald-700 dark:text-emerald-400">{JSON.stringify(value)}</span>;
  }
  if (typeof value === 'number') {
    return <span className="text-sky-700 dark:text-sky-400">{String(value)}</span>;
  }
  return <span className="text-violet-700 dark:text-violet-400">{String(value)}</span>;
}

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const label = name !== undefined && (
    <span className="text-foreground/80">
      {name}
      <span className="text-muted-foreground">: </span>
    </span>
  );
  if (value === null || typeof value !== 'object') {
    return (
      <div className="pl-4">
        {label}
        <Primitive value={value} />
      </div>
    );
  }
  const array = Array.isArray(value);
  const entries: [string, unknown][] = array
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  const [lb, rb] = array ? ['[', ']'] : ['{', '}'];
  return (
    <div className={depth > 0 ? 'pl-4' : undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="-ml-4 inline-flex items-center text-left hover:text-foreground"
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className="ml-1">
          {label}
          <span className="text-muted-foreground">
            {lb}
            {!open && ` ${entries.length} ${rb}`}
          </span>
        </span>
      </button>
      {open && (
        <>
          {entries.map(([key, item]) => (
            <JsonNode key={key} name={array ? undefined : key} value={item} depth={depth + 1} />
          ))}
          <div className="text-muted-foreground">{rb}</div>
        </>
      )}
    </div>
  );
}

/** ```json 围栏：可折叠的树，可切回原文 */
export function JsonTree({ source, value }: { source: string; value: unknown }) {
  const { t } = useI18n();
  const [raw, setRaw] = useState(false);
  const tab = (active: boolean) =>
    cn('rounded px-1.5 py-0.5', active ? 'bg-muted text-foreground' : 'hover:text-foreground');
  return (
    <div data-enso="json-tree" className="group/code relative my-2 rounded-lg border">
      <div className="flex items-center gap-1 border-b px-2 py-1 text-[11px] text-muted-foreground">
        <span className="mr-auto font-mono">JSON</span>
        <button type="button" className={tab(!raw)} onClick={() => setRaw(false)}>
          {t('Tree view')}
        </button>
        <button type="button" className={tab(raw)} onClick={() => setRaw(true)}>
          {t('Raw text')}
        </button>
        <CopyButton text={source} className="rounded p-1" />
      </div>
      {raw ? (
        <div className="px-2">
          <CodeBlock code={source} language="json" />
        </div>
      ) : (
        <div className="max-h-[480px] overflow-auto py-2 pr-3 pl-6 font-mono text-(length:--chat-code-block-size) leading-relaxed">
          <JsonNode value={value} depth={0} />
        </div>
      )}
    </div>
  );
}
