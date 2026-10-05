import { describe, expect, it } from 'vitest';
import { parseDelegation, parseGroupTask, parseTaskCheck } from '../types/bot';
import { checkFailureText, checkPassed, normalizeTaskCheck } from './taskCheck';

const check = { kind: 'output-contains' as const, text: 'XYZ_PASS' };
const result = (
  toolCallId: string,
  text: string,
  extra: { isError?: boolean; timestamp?: number; toolName?: string } = {}
) => ({
  role: 'toolResult',
  toolCallId,
  toolName: extra.toolName ?? 'bash',
  timestamp: extra.timestamp ?? 100,
  content: [{ type: 'text', text }],
  ...(extra.isError !== undefined ? { isError: extra.isError } : {}),
});

describe('parseTaskCheck', () => {
  it('只接受 output-contains 且 text 1–200 字', () => {
    expect(parseTaskCheck(check)).toEqual(check);
    expect(parseTaskCheck({ ...check, text: '  a  ' })).toEqual({ ...check, text: 'a' });
    expect(parseTaskCheck({ ...check, passed: false })).toEqual({ ...check, passed: false });
    expect(parseTaskCheck({ ...check, text: '   ' })).toBeUndefined();
    expect(parseTaskCheck({ ...check, text: 'x'.repeat(201) })).toBeUndefined();
    expect(parseTaskCheck({ kind: 'exit-code', text: 'a' })).toBeUndefined();
    expect(parseTaskCheck('XYZ')).toBeUndefined();
  });

  it('委派记录与看板任务携带验收条件，坏值丢弃', () => {
    const base = {
      id: '00000000-0000-4000-8000-000000000001',
      parentConversationId: 'p',
      parentBotId: '00000000-0000-4000-8000-000000000002',
      targetBotId: '00000000-0000-4000-8000-000000000003',
      chatId: null,
      task: 't',
      context: '',
      childConversationId: 'c',
      state: 'failed',
      failure: 'check',
      depth: 1,
      createdAt: 1,
    };
    expect(parseDelegation({ ...base, check: { ...check, passed: false } })).toMatchObject({
      failure: 'check',
      check: { ...check, passed: false },
    });
    expect(parseDelegation({ ...base, check: { kind: 'x' } })?.check).toBeUndefined();
    const task = {
      id: '00000000-0000-4000-8000-000000000004',
      seq: 1,
      title: 't',
      status: 'todo',
      createdBy: 'human',
      createdAt: 1,
      updatedAt: 1,
    };
    expect(parseGroupTask({ ...task, check, claimedAt: 5 })).toMatchObject({ check, claimedAt: 5 });
    expect(parseGroupTask({ ...task, check: 'x' })?.check).toBeUndefined();
  });
});

describe('normalizeTaskCheck', () => {
  it('字符串视为 output-contains；null / 空串视为未传', () => {
    expect(normalizeTaskCheck('XYZ')).toEqual({ kind: 'output-contains', text: 'XYZ' });
    expect(normalizeTaskCheck({ text: 'XYZ' })).toEqual({ kind: 'output-contains', text: 'XYZ' });
    expect(normalizeTaskCheck({ kind: 'output_contains', text: 'XYZ' })).toEqual({
      kind: 'output-contains',
      text: 'XYZ',
    });
    expect(normalizeTaskCheck(null)).toBeUndefined();
    expect(normalizeTaskCheck('  ')).toBeUndefined();
    expect(normalizeTaskCheck(3)).toBe(3);
  });
});

describe('checkPassed', () => {
  it('在起点之后的工具结果里找到文本才通过', () => {
    expect(checkPassed(check, [result('a', 'out: XYZ_PASS\n')], 50)).toBe(true);
    expect(checkPassed(check, [result('a', 'XYZ_PASS', { timestamp: 10 })], 50)).toBe(false);
    expect(checkPassed(check, [], 0)).toBe(false);
  });

  it('按 toolCallId 取最终结果：最终错误不能沿用中途的 PASS', () => {
    expect(
      checkPassed(check, [result('a', 'XYZ_PASS'), result('a', 'XYZ_PASS', { isError: true })], 0)
    ).toBe(false);
    expect(checkPassed(check, [result('a', 'XYZ_PASS'), result('a', 'nothing')], 0)).toBe(false);
    expect(
      checkPassed(check, [result('a', 'boom', { isError: true }), result('b', 'XYZ_PASS')], 0)
    ).toBe(true);
  });

  it('不认助手正文与协作工具回显', () => {
    expect(
      checkPassed(
        check,
        [
          { role: 'assistant', timestamp: 100, content: [{ type: 'text', text: 'XYZ_PASS' }] },
          result('a', '{"check":"XYZ_PASS"}', { toolName: 'group_tasks' }),
          result('b', 'XYZ_PASS', { toolName: 'delegate' }),
        ],
        0
      )
    ).toBe(false);
  });

  it('未通过说明带上期望文本', () => {
    expect(checkFailureText(check)).toBe('验收未通过：未在工具输出中看到「XYZ_PASS」');
  });
});
