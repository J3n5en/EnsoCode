import { describe, expect, it } from 'vitest';
import {
  applyInterceptResult,
  BEFORE_AGENT_START_APPEND_MAX,
  initialInterceptState,
} from './events';

describe('applyInterceptResult', () => {
  it('tool_call：改写参数累积，拦截后停止', () => {
    let s = initialInterceptState('tool_call', {
      toolCallId: 't',
      toolName: 'bash',
      input: { cmd: 'ls' },
    });
    s = applyInterceptResult(s, { input: { cmd: 'ls -la' } });
    expect(s).toMatchObject({ done: false, result: { input: { cmd: 'ls -la' } } });
    s = applyInterceptResult(s, { block: true, reason: 'no' });
    expect(s).toMatchObject({ done: true, result: { block: true, reason: 'no' } });
  });

  it('tool_result：只接受字符串 content', () => {
    let s = initialInterceptState('tool_result', {
      toolCallId: 't',
      toolName: 'read',
      input: {},
      content: 'raw',
      isError: false,
    });
    s = applyInterceptResult(s, { content: 42 });
    expect(s.result).toEqual({});
    s = applyInterceptResult(s, { content: 'masked' });
    expect(s.result).toEqual({ content: 'masked' });
  });

  it('input：transform 累积，handled 终止，其他返回当 continue', () => {
    let s = initialInterceptState('input', { text: 'hi', source: 'interactive' });
    s = applyInterceptResult(s, undefined);
    expect(s.result).toEqual({ action: 'continue' });
    s = applyInterceptResult(s, { action: 'transform', text: 'hello' });
    expect(s.result).toEqual({ action: 'transform', text: 'hello' });
    s = applyInterceptResult(s, { action: 'handled' });
    expect(s).toMatchObject({ done: true, result: { action: 'handled' } });
  });

  it('不合法的 input 改写被忽略', () => {
    let s = initialInterceptState('tool_call', {
      toolCallId: 't',
      toolName: 'bash',
      input: { cmd: 'ls' },
    });
    s = applyInterceptResult(s, { input: 'rm -rf /' });
    expect(s.result).toEqual({});
  });

  it('before_agent_start：append 依次拼接，非字符串忽略，总长截到上限', () => {
    let s = initialInterceptState('before_agent_start', { prompt: 'hi', kind: 'user' });
    expect(s.result).toEqual({});
    s = applyInterceptResult(s, { append: 42 });
    expect(s.result).toEqual({});
    s = applyInterceptResult(s, { append: '项目约定 A' });
    s = applyInterceptResult(s, { append: '项目约定 B' });
    expect(s).toMatchObject({ done: false, result: { append: '项目约定 A\n\n项目约定 B' } });
    s = applyInterceptResult(s, { append: 'x'.repeat(BEFORE_AGENT_START_APPEND_MAX) });
    expect(s.result.append?.length).toBe(BEFORE_AGENT_START_APPEND_MAX);
  });
});
