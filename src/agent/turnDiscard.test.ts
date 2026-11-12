import { PLUGIN_MESSAGE_TYPE } from '@shared/extensionPlugins/protocol';
import { describe, expect, it } from 'vitest';
import { planTurnDiscard, readOnlyCall, recallDiscarded, turnDiscardEdits } from './turnDiscard';

const delivery = (id: string, content: unknown = 'news') => ({
  id,
  type: 'custom_message',
  customType: PLUGIN_MESSAGE_TYPE,
  content,
});
const msg = (id: string, role: string, content: unknown = []) => ({
  id,
  type: 'message',
  message: { role, content },
});
const call = (id: string, name: string, args: Record<string, unknown> = {}) =>
  msg(id, 'assistant', [{ type: 'toolCall', id: `c-${id}`, name, arguments: args }]);
const readOnly = (name: string, args: unknown) => readOnlyCall(name, args, new Set(['mcp_ro']));

describe('planTurnDiscard', () => {
  it('插件投递触发、只调 turn_discard 的本轮：投递条目与本轮消息都纳入', () => {
    const branch = [
      msg('u1', 'user'),
      msg('a1', 'assistant'),
      delivery('d1'),
      { id: 'x', type: 'model_change' },
      delivery('d2'),
      call('a2', 'turn_discard'),
      msg('r2', 'toolResult'),
    ];
    expect(planTurnDiscard(branch)).toEqual({ triggers: ['d1', 'd2'], run: ['a2', 'r2'] });
  });

  it('前一次丢弃留下的 context_edit 与工具结果不会被并入本次', () => {
    const branch = [
      delivery('d1'),
      call('a1', 'turn_discard'),
      msg('r1', 'toolResult'),
      { id: 'e1', type: 'context_edit' },
      delivery('d2'),
      call('a2', 'turn_discard'),
    ];
    expect(planTurnDiscard(branch)).toEqual({ triggers: ['d2'], run: ['a2'] });
  });

  it('用户消息触发的轮次也可丢弃', () => {
    expect(planTurnDiscard([msg('u1', 'user'), call('a1', 'turn_discard')])).toEqual({
      triggers: ['u1'],
      run: ['a1'],
    });
  });

  it('本轮只用过只读工具时可丢，查询过程一并纳入', () => {
    const branch = [
      delivery('d1'),
      call('a1', 'read'),
      msg('r1', 'toolResult'),
      call('a2', 'bash', { command: 'git log --oneline -3' }),
      msg('r2', 'toolResult'),
      call('a3', 'mcp_ro'),
      msg('r3', 'toolResult'),
      call('a4', 'turn_discard'),
    ];
    expect(planTurnDiscard(branch, readOnly)).toEqual({
      triggers: ['d1'],
      run: ['a1', 'r1', 'a2', 'r2', 'a3', 'r3', 'a4'],
    });
  });

  it('本轮有副作用的工具调用时拒绝', () => {
    for (const side of [
      call('a1', 'tg_send_message'),
      call('a1', 'bash', { command: 'rm -rf x' }),
    ]) {
      const branch = [delivery('d1'), side, msg('r1', 'toolResult'), call('a2', 'turn_discard')];
      expect(planTurnDiscard(branch, readOnly)).toBeTypeOf('string');
    }
  });

  it('本轮中途插入的用户消息之后才是可丢的范围', () => {
    const branch = [
      delivery('d1'),
      call('a1', 'read'),
      msg('r1', 'toolResult'),
      msg('u1', 'user'),
      call('a2', 'turn_discard'),
    ];
    expect(planTurnDiscard(branch, readOnly)).toEqual({ triggers: ['u1'], run: ['a2'] });
  });

  it('非插件的 custom_message 不算自动投递', () => {
    const branch = [
      { id: 'c1', type: 'custom_message', customType: 'other', content: 'x' },
      call('a1', 'turn_discard'),
    ];
    expect(planTurnDiscard(branch)).toBeTypeOf('string');
  });
});

describe('turnDiscardEdits', () => {
  it('投递替换为带 id 与原因的痕迹，本轮消息整条省略', () => {
    const edits = turnDiscardEdits({ triggers: ['d1'], run: ['a1', 'r1'] }, 'chip news');
    expect(edits.map((e) => [e.targetId, e.replacement === null])).toEqual([
      ['d1', false],
      ['a1', true],
      ['r1', true],
    ]);
    const trace = JSON.stringify(edits[0]!.replacement);
    expect(trace).toContain('d1');
    expect(trace).toContain('chip news');
  });

  it('不填原因时痕迹只留 id', () => {
    const [edit] = turnDiscardEdits({ triggers: ['d1'], run: [] }, '');
    const trace = (edit!.replacement as { content: string }).content;
    expect(trace).toContain('[Discarded turn input d1]');
    expect(trace).not.toContain('d1:');
  });
});

describe('recallDiscarded', () => {
  it('只取回已被丢弃的插件投递或用户消息原文', () => {
    const branch = [
      delivery('d1', [{ type: 'text', text: 'ORIGINAL' }]),
      delivery('d2', 'kept'),
      { id: 'e1', type: 'context_edit', targetId: 'd1' },
      msg('u1', 'user', 'secret'),
      { id: 'e2', type: 'context_edit', targetId: 'u1' },
      msg('u2', 'user', 'kept'),
      msg('a1', 'assistant', [{ type: 'text', text: 'answer' }]),
      { id: 'e3', type: 'context_edit', targetId: 'a1' },
    ];
    expect(recallDiscarded(branch, 'd1')).toBe('ORIGINAL');
    expect(recallDiscarded(branch, 'u1')).toBe('secret');
    expect(() => recallDiscarded(branch, 'd2')).toThrow();
    expect(() => recallDiscarded(branch, 'u2')).toThrow();
    expect(() => recallDiscarded(branch, 'a1')).toThrow();
    expect(() => recallDiscarded(branch, 'nope')).toThrow();
  });
});
