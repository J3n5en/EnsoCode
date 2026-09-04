import { describe, expect, it } from 'vitest';
import { runFooter } from './runFooter';

const call = (name: string) => ({ type: 'toolCall', id: 'c', name, arguments: {} });

describe('runFooter', () => {
  it('统计各工具调用次数,按次数降序,命令工具未用时用中性的 shell 0 标注', () => {
    const footer = runFooter({
      messages: [
        { role: 'assistant', content: [call('read'), call('grep'), call('read')] },
        { role: 'toolResult' },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
      label: 'scout',
      modelId: 'm',
      elapsedMs: 133_000,
    });
    expect(footer).toContain('read 2, grep 1');
    expect(footer).toContain('shell 0');
    expect(footer).not.toContain('bash 0');
    expect(footer).toContain('2m13s');
    expect(footer).toContain('scout');
    expect(footer).toContain('m');
  });

  it('bash 用过时不再标 shell 0', () => {
    const footer = runFooter({
      messages: [{ role: 'assistant', content: [call('bash')] }],
      label: 'worker',
      modelId: 'm',
      elapsedMs: 900,
    });
    expect(footer).toContain('bash 1');
    expect(footer).not.toContain('shell 0');
    expect(footer).toContain('0.9s');
  });

  it('powershell 用过时不再标 shell 0', () => {
    const footer = runFooter({
      messages: [{ role: 'assistant', content: [call('powershell')] }],
      label: 'worker',
      modelId: 'm',
      elapsedMs: 900,
    });
    expect(footer).toContain('powershell 1');
    expect(footer).not.toContain('shell 0');
  });

  it('没有任何工具调用时标 no tool calls', () => {
    const footer = runFooter({
      messages: [{ role: 'assistant', content: 'hi' }],
      label: 'x',
      modelId: 'm',
      elapsedMs: 0,
    });
    expect(footer).toContain('no tool calls');
  });

  it('最后一条 assistant 命中模型输出上限时标 incomplete', () => {
    const footer = runFooter({
      messages: [{ role: 'assistant', content: 'x', stopReason: 'length' }],
      label: 'x',
      modelId: 'm',
      elapsedMs: 0,
    });
    expect(footer).toMatch(/incomplete/i);
  });

  it('给了上下文窗口时附上下文占用百分比', () => {
    const footer = runFooter({
      messages: [{ role: 'assistant', content: 'x', usage: { input: 300, output: 100 } }],
      label: 'x',
      modelId: 'm',
      elapsedMs: 0,
      contextWindow: 1000,
    });
    expect(footer).toContain('ctx 40%');
  });

  it('脏输入:content 非数组、缺 name 的 toolCall 不计入也不抛', () => {
    const footer = runFooter({
      messages: [
        { role: 'assistant', content: [{ type: 'toolCall' }, null, 'str'] },
        { role: 'assistant', content: 42 },
      ] as unknown[],
      label: 'x',
      modelId: 'm',
      elapsedMs: 0,
    });
    expect(footer).toContain('no tool calls');
  });
});
