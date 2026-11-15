import type { SecretaryResultKind, SecretaryTodo, TodoProblemCode } from '@shared/types/secretary';

export type TodoStatus = 'todo' | 'active' | 'problem' | 'done';

export const TODO_STATUSES: readonly TodoStatus[] = ['todo', 'active', 'problem', 'done'];

export interface TodoSessionView {
  present: boolean;
  title?: string;
  state: 'running' | 'idle' | 'waiting' | 'error' | 'not-started';
  result?: SecretaryResultKind;
  /** 这一轮是用户中断的；不落在记录上，只在当次事件里为真 */
  aborted?: boolean;
}

const LIVE = new Set<TodoSessionView['state']>(['running', 'waiting']);

function live(session: TodoSessionView): boolean {
  return LIVE.has(session.state);
}

function patchTodo(
  todo: SecretaryTodo,
  patch: {
    conversationId?: string | null;
    problem?: TodoProblemCode | null;
    doneAt?: number | null;
  },
  now: number
): SecretaryTodo {
  const next: SecretaryTodo = { ...todo, updatedAt: now };
  if (patch.conversationId === null) delete next.conversationId;
  else if (patch.conversationId) next.conversationId = patch.conversationId;
  if (patch.problem === null) delete next.problem;
  else if (patch.problem) next.problem = patch.problem;
  if (patch.doneAt === null) delete next.doneAt;
  else if (typeof patch.doneAt === 'number') next.doneAt = patch.doneAt;
  return next;
}

/**
 * 关联会话走到终态时推进待办。没变化时返回原对象。
 * 完成必须是 goal-complete 且会话已经不在运行或等待；失败、中断、消失不能停在进行中。
 */
export function advanceTodo(
  todo: SecretaryTodo,
  session: TodoSessionView | null,
  now: number
): SecretaryTodo {
  if (todo.doneAt !== undefined || !todo.conversationId) return todo;
  if (!session?.present) {
    return todo.problem === 'deleted' ? todo : patchTodo(todo, { problem: 'deleted' }, now);
  }
  if (session.result === 'goal-complete' && !live(session)) {
    return patchTodo(todo, { doneAt: now, problem: null }, now);
  }
  if (session.aborted || session.result === 'interrupted') {
    return todo.problem === 'stopped' ? todo : patchTodo(todo, { problem: 'stopped' }, now);
  }
  if (todo.problem === 'stopped') return todo;
  if (live(session)) {
    return todo.problem ? patchTodo(todo, { problem: null }, now) : todo;
  }
  if (session.result === 'failed' || session.state === 'error') {
    return todo.problem === 'failed' ? todo : patchTodo(todo, { problem: 'failed' }, now);
  }
  return todo;
}

/** 和 advanceTodo 同一套判定，给列表和看板投影用，不写盘 */
export function todoStatus(todo: SecretaryTodo, session: TodoSessionView | null): TodoStatus {
  if (todo.doneAt !== undefined) return 'done';
  if (!todo.conversationId) return todo.problem ? 'problem' : 'todo';
  if (!session?.present) return 'problem';
  if (session.result === 'goal-complete' && !live(session)) return 'done';
  if (session.aborted || session.result === 'interrupted' || todo.problem === 'stopped')
    return 'problem';
  if (live(session)) return 'active';
  if (
    session.result === 'failed' ||
    session.state === 'error' ||
    todo.problem === 'failed' ||
    todo.problem === 'deleted'
  ) {
    return 'problem';
  }
  return 'active';
}

export function todoSessionView(
  row: Record<string, unknown> | undefined,
  status: { state: 'running' | 'idle' | 'waiting' | 'error' } | undefined,
  result: SecretaryResultKind | undefined,
  aborted = false
): TodoSessionView {
  if (!row) return { present: false, state: 'not-started', ...(aborted ? { aborted: true } : {}) };
  const title = typeof row.title === 'string' && row.title.trim() ? row.title : undefined;
  const state = row.sessionFile ? (status?.state ?? 'idle') : 'not-started';
  return {
    present: true,
    ...(title ? { title } : {}),
    state,
    ...(result ? { result } : {}),
    ...(aborted ? { aborted: true } : {}),
  };
}

export function advanceTodos(
  todos: readonly SecretaryTodo[],
  sessionOf: (conversationId: string) => TodoSessionView,
  now: number
): { todos: SecretaryTodo[]; changed: boolean } {
  let changed = false;
  const next = todos.map((todo) => {
    if (!todo.conversationId || todo.doneAt !== undefined) return todo;
    const advanced = advanceTodo(todo, sessionOf(todo.conversationId), now);
    if (advanced !== todo) changed = true;
    return advanced;
  });
  return { todos: next, changed };
}

/** 派发成功后只改这一条，调用方必须用刚读到的列表，不能用派发开始前的快照 */
export function linkTodo(
  todos: readonly SecretaryTodo[],
  todoId: string,
  conversationId: string,
  now: number
): { todos: SecretaryTodo[]; changed: boolean } {
  let changed = false;
  const next = todos.map((todo) => {
    if (todo.id !== todoId) return todo;
    if (todo.conversationId === conversationId && todo.problem === undefined) return todo;
    changed = true;
    const linked: SecretaryTodo = { ...todo, conversationId, updatedAt: now };
    delete linked.problem;
    return linked;
  });
  return { todos: next, changed };
}

export function markTodoProblem(
  todos: readonly SecretaryTodo[],
  conversationId: string,
  problem: TodoProblemCode,
  now: number
): { todos: SecretaryTodo[]; changed: boolean } {
  let changed = false;
  const next = todos.map((todo) => {
    if (todo.conversationId !== conversationId || todo.doneAt !== undefined) return todo;
    if (todo.problem === problem) return todo;
    changed = true;
    return patchTodo(todo, { problem }, now);
  });
  return { todos: next, changed };
}

/** 用户把进行中或出问题的待办拖回待办列：解开会话，清掉原因，不改完成状态 */
export function reopenTodo(
  todos: readonly SecretaryTodo[],
  todoId: string,
  now: number
): { todos: SecretaryTodo[]; changed: boolean; found: boolean } {
  let found = false;
  let changed = false;
  const next = todos.map((todo) => {
    if (todo.id !== todoId) return todo;
    found = true;
    if (todo.conversationId === undefined && todo.problem === undefined) return todo;
    changed = true;
    const opened: SecretaryTodo = { ...todo, updatedAt: now };
    delete opened.conversationId;
    delete opened.problem;
    return opened;
  });
  return { todos: next, changed, found };
}

/** 已完成或出问题的会话被重新唤起：待办回到进行中，会话关联留着 */
export function resumeLinkedTodo(
  todos: readonly SecretaryTodo[],
  conversationId: string,
  now: number
): { todos: SecretaryTodo[]; changed: boolean } {
  let changed = false;
  const next = todos.map((todo) => {
    if (todo.conversationId !== conversationId) return todo;
    if (todo.doneAt === undefined && todo.problem === undefined) return todo;
    changed = true;
    const resumed: SecretaryTodo = { ...todo, updatedAt: now };
    delete resumed.doneAt;
    delete resumed.problem;
    return resumed;
  });
  return { todos: next, changed };
}
