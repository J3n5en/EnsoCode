import type { SecretaryToolDescriptor } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import type { MemoryInvoker } from './memory';
import { createSecretaryCustomTools } from './secretaryCustomTools';

const descriptor: SecretaryToolDescriptor = {
  name: 'my_upper_text',
  description: '把文本转成大写',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  readOnly: true,
};

function stubInvoker(outcome: unknown) {
  const calls: { op: string; params: unknown; timeoutMs: number | undefined }[] = [];
  async function invoke(op: string, params: unknown, _signal?: AbortSignal, timeoutMs?: number) {
    calls.push({ op, params, timeoutMs });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
  const invoker = { invoke } as unknown as MemoryInvoker<'tool_run'>;
  return { invoker, calls };
}

describe('createSecretaryCustomTools', () => {
  it('按描述符挂工具，只读标记随描述符', () => {
    const [tool] = createSecretaryCustomTools(stubInvoker({}).invoker, [descriptor]);
    expect(tool.name).toBe('my_upper_text');
    expect(tool.description).toBe(descriptor.description);
    expect(tool.parameters).toEqual(descriptor.parameters);
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('调用转成 tool_run，名字换回目录 slug，带上本次描述符的只读标记', async () => {
    const { invoker, calls } = stubInvoker({
      output: '<untrusted-content source="tool:upper-text">HELLO</untrusted-content>',
    });
    const [tool] = createSecretaryCustomTools(invoker, [descriptor]);
    const result = await tool.execute(
      'call-1',
      { text: 'hello' },
      undefined,
      undefined,
      undefined as never
    );
    expect(calls).toEqual([
      {
        op: 'tool_run',
        params: { name: 'upper-text', arguments: { text: 'hello' }, readOnly: true },
        timeoutMs: 305_000,
      },
    ]);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: '<untrusted-content source="tool:upper-text">HELLO</untrusted-content>',
      },
    ]);
    expect(result.isError).toBeUndefined();
  });

  it('Main 报错时把错误文案当工具错误', async () => {
    const { invoker } = stubInvoker(new Error('not-found'));
    const [tool] = createSecretaryCustomTools(invoker, [descriptor]);
    const result = await tool.execute('call-1', {}, undefined, undefined, undefined as never);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'not-found' }]);
  });
});
