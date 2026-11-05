import type { TodoItem } from '@shared/types/agent';
import { Check, ChevronDown, ChevronRight, Circle, CircleDot, ListTodo, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '@/i18n';
import { latestUnfinishedTodos } from '@/lib/pinnedTodos';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

/** ✓/●/○ 清单；时间线 todo 行与固定待办条共用 */
export function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="space-y-0.5 text-xs">
      {todos.map((todo) => (
        <li key={todo.content} className="flex items-start gap-1.5">
          {todo.status === 'completed' ? (
            <Check className="mt-0.5 h-3 w-3 shrink-0 text-brand" />
          ) : todo.status === 'in_progress' ? (
            <CircleDot className="mt-0.5 h-3 w-3 shrink-0 text-brand" />
          ) : (
            <Circle className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50" />
          )}
          <span
            className={cn(
              todo.status === 'completed'
                ? 'text-muted-foreground line-through'
                : todo.status === 'in_progress'
                  ? 'font-medium'
                  : 'text-muted-foreground'
            )}
          >
            {todo.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 清单进度条：强调色只用在完成比例上 */
export function TodoProgress({
  done,
  total,
  className,
}: {
  done: number;
  total: number;
  className?: string;
}) {
  return (
    <div className={cn('h-0.5 overflow-hidden rounded-full bg-border', className)}>
      <div
        className="h-full rounded-full bg-brand transition-[width]"
        style={{ width: `${total ? (done / total) * 100 : 0}%` }}
      />
    </div>
  );
}

/** 会话内已手动隐藏的清单（按 todo toolCallId）；模型更新清单后换新 id 自动重新出现 */
const hiddenTodoLists = new Set<string>();

/** 输入框上方的固定待办条：最新清单仍有未完成项时显示，默认一行摘要，可展开 */
export function TodoBar({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const enabled = useSettingsStore((s) => s.pinUnfinishedTodos);
  const messages = useSessionsStore((s) => s.conversations[conversationId]?.messages);
  const list = useMemo(
    () => (enabled && messages ? latestUnfinishedTodos(messages) : null),
    [enabled, messages]
  );
  const [expanded, setExpanded] = useState(false);
  const [, setHiddenVersion] = useState(0);
  if (!list || hiddenTodoLists.has(list.id)) return null;
  const done = list.todos.filter((todo) => todo.status === 'completed').length;
  const current =
    list.todos.find((todo) => todo.status === 'in_progress') ??
    list.todos.find((todo) => todo.status === 'pending');
  return (
    <div
      data-enso="todo"
      className="mb-1.5 rounded-xl border bg-card px-3 py-1.5 text-xs shadow-xs"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ListTodo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium">{t('Todos')}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
            {done}/{list.todos.length}
          </span>
          {!expanded && current && (
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={current.content}>
              {current.content}
            </span>
          )}
          {expanded ? (
            <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
        <button
          type="button"
          title={t('Hide until the todo list updates')}
          onClick={() => {
            hiddenTodoLists.add(list.id);
            setHiddenVersion((value) => value + 1);
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {expanded && (
        <div className="mt-1.5 max-h-48 overflow-y-auto pb-0.5">
          <TodoProgress done={done} total={list.todos.length} className="mb-2" />
          <TodoList todos={list.todos} />
        </div>
      )}
    </div>
  );
}
