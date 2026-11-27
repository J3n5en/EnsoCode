import type { ProjectedMessage, TodoItem } from '@shared/types/agent';

/**
 * todo 是整表替换：只看最后一份清单，仍有未完成项才固定显示。
 * toolTodos 是已收口、toolResult 还没落地的 todo 清单（agy 轮末才落盘），按其 toolCall 的位置参与排序。
 */
export function latestUnfinishedTodos(
  messages: readonly ProjectedMessage[],
  toolTodos?: Readonly<Record<string, TodoItem[]>>
): { id: string; todos: TodoItem[] } | null {
  const unfinished = (id: string, todos: TodoItem[]) =>
    todos.some((todo) => todo.status !== 'completed') ? { id, todos } : null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (toolTodos && message.role === 'assistant' && Array.isArray(message.content)) {
      for (let part = message.content.length - 1; part >= 0; part -= 1) {
        const call = message.content[part];
        if (call.type !== 'toolCall' || call.name !== 'todo') continue;
        const live = toolTodos[call.id];
        if (live) return unfinished(call.id, live);
      }
    }
    if (message.role !== 'toolResult' || message.toolName !== 'todo' || !message.todos) continue;
    return unfinished(message.toolCallId ?? String(index), message.todos);
  }
  return null;
}
