import type { SecretaryTodo } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import {
  advanceTodo,
  advanceTodos,
  linkTodo,
  markTodoProblem,
  reopenTodo,
  type TodoSessionView,
  todoStatus,
} from './todoLifecycle';

const NOW = 50;

function todo(extra: Partial<SecretaryTodo> = {}): SecretaryTodo {
  return { id: 't1', text: '看构建', createdAt: 1, updatedAt: 1, conversationId: 'c1', ...extra };
}

function session(extra: Partial<TodoSessionView> = {}): TodoSessionView {
  return { present: true, state: 'running', title: '看构建', ...extra };
}

describe('advanceTodo', () => {
  it('进行中的会话保持关联，不打勾', () => {
    const item = todo();
    expect(advanceTodo(item, session(), NOW)).toBe(item);
    expect(todoStatus(item, session())).toBe('active');
    expect(todoStatus(item, session({ state: 'waiting', result: 'needs-user' }))).toBe('active');
  });

  it('goal-complete 且会话已结束才打勾；还在跑时不动', () => {
    const item = todo();
    const running = session({ result: 'goal-complete', state: 'running' });
    expect(advanceTodo(item, running, NOW)).toBe(item);
    const idle = session({ result: 'goal-complete', state: 'idle' });
    const done = advanceTodo(todo(), idle, NOW);
    expect(done.doneAt).toBe(NOW);
    expect(done.problem).toBeUndefined();
    expect(todoStatus(todo(), idle)).toBe('done');
  });

  it('失败、中断、删除都离开进行中并记下原因', () => {
    expect(advanceTodo(todo(), session({ state: 'error', result: 'failed' }), NOW).problem).toBe(
      'failed'
    );
    expect(advanceTodo(todo(), session({ state: 'idle', aborted: true }), NOW).problem).toBe(
      'stopped'
    );
    expect(
      advanceTodo(todo(), session({ state: 'idle', result: 'interrupted' }), NOW).problem
    ).toBe('stopped');
    const deleted = advanceTodo(todo(), { present: false, state: 'not-started' }, NOW);
    expect(deleted.problem).toBe('deleted');
    expect(deleted.conversationId).toBe('c1');
    expect(todoStatus(deleted, { present: false, state: 'not-started' })).toBe('problem');
  });

  it('普通轮次结束仍算进行中；停止原因不会被随后的空闲清掉', () => {
    const idle = session({ state: 'idle', result: 'turn-ended' });
    const item = todo();
    expect(advanceTodo(item, idle, NOW)).toBe(item);
    expect(todoStatus(item, idle)).toBe('active');
    const stopped = todo({ problem: 'stopped' });
    expect(advanceTodo(stopped, session({ state: 'idle' }), NOW)).toBe(stopped);
  });

  it('失败后会话又跑起来则清掉原因', () => {
    const failed = todo({ problem: 'failed' });
    expect(advanceTodo(failed, session({ state: 'running' }), NOW).problem).toBeUndefined();
  });

  it('被标成 stopped 的待办：会话恢复运行（即使残留 interrupted）自动回到 active，完成后回到 done', () => {
    const stopped = todo({ problem: 'stopped' });
    const resumed = session({ state: 'running', result: 'interrupted' });
    expect(todoStatus(stopped, resumed)).toBe('active');
    const active = advanceTodo(stopped, resumed, NOW);
    expect(active.problem).toBeUndefined();
    expect(active.doneAt).toBeUndefined();

    const completed = session({ state: 'idle', result: 'goal-complete' });
    expect(todoStatus(stopped, completed)).toBe('done');
    const done = advanceTodo(stopped, completed, NOW);
    expect(done.doneAt).toBe(NOW);
    expect(done.problem).toBeUndefined();
  });
});

describe('待办写回', () => {
  it('关联会话时用新列表，不把期间改过的文字和完成状态盖回去', () => {
    const updated = todo({ text: '看发布', doneAt: NOW, conversationId: undefined });
    const linked = linkTodo([updated], 't1', 'new-1', NOW + 1);
    expect(linked.changed).toBe(true);
    expect(linked.todos[0]).toMatchObject({
      text: '看发布',
      doneAt: NOW,
      conversationId: 'new-1',
    });
  });

  it('停止只标关联着的未完成待办', () => {
    const items = [todo(), todo({ id: 't2', conversationId: 'c2' }), todo({ id: 't3', doneAt: 1 })];
    const marked = markTodoProblem(items, 'c1', 'stopped', NOW);
    expect(marked.todos.map((item) => item.problem ?? null)).toEqual(['stopped', null, null]);
  });

  it('放回待办列解开会话和原因，不改已完成', () => {
    const opened = reopenTodo([todo({ problem: 'failed', doneAt: 3 })], 't1', NOW);
    expect(opened.found).toBe(true);
    expect(opened.todos[0].conversationId).toBeUndefined();
    expect(opened.todos[0].problem).toBeUndefined();
    expect(opened.todos[0].doneAt).toBe(3);
    expect(reopenTodo([todo({ id: 'missing' })], 'nope', NOW).found).toBe(false);
  });

  it('按会话快照推进多条', () => {
    const items = [todo(), todo({ id: 't2', conversationId: undefined })];
    const advanced = advanceTodos(
      items,
      () => session({ state: 'idle', result: 'goal-complete' }),
      NOW
    );
    expect(advanced.changed).toBe(true);
    expect(advanced.todos[0].doneAt).toBe(NOW);
    expect(advanced.todos[1]).toBe(items[1]);
  });
});
