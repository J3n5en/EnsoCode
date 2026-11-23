import { describe, expect, it, vi } from 'vitest';
import { createMemoryServiceBridge, type MemoryServicePort } from './bridge';

function makePort() {
  const posted: unknown[] = [];
  let listener: ((data: unknown) => void) | null = null;
  const port: MemoryServicePort = {
    postMessage: (m) => posted.push(m),
    onMessage: (fn) => {
      listener = fn;
    },
  };
  return {
    port,
    posted,
    emit: (data: unknown) => listener?.(data),
  };
}

describe('memoryService bridge', () => {
  it('requestTranscript 收到 transcript-result 后立即返回消息列表，不再等到超时回空', async () => {
    const { port, posted, emit } = makePort();
    const bridge = createMemoryServiceBridge(port, vi.fn(), { transcriptTimeoutMs: 200 });

    const pending = bridge.requestTranscript('/sessions/s1.jsonl');
    expect(posted).toEqual([
      { type: 'transcript-request', requestId: 1, sessionFile: '/sessions/s1.jsonl' },
    ]);

    const messages = [{ role: 'user', text: 'hello', entryId: 'e1' }];
    emit({ type: 'transcript-result', requestId: 1, messages });

    await expect(pending).resolves.toEqual(messages);
  });

  it('remoteComplete 发出 llm-request 并把 llm-result / llm-error / abort 透传回调用方', async () => {
    const { port, posted, emit } = makePort();
    const bridge = createMemoryServiceBridge(port, vi.fn());
    const complete = await bridge.remoteComplete();
    expect(complete).not.toBeNull();

    const p1 = complete!('sys prompt', 'user text', { maxTokens: 512, stage: 'extract' });
    expect(posted).toEqual([
      {
        type: 'llm-request',
        requestId: 1,
        system: 'sys prompt',
        user: 'user text',
        maxTokens: 512,
        stage: 'extract',
      },
    ]);
    emit({ type: 'llm-result', requestId: 1, text: '{"memories":[]}' });
    await expect(p1).resolves.toBe('{"memories":[]}');

    const ac = new AbortController();
    const p2 = complete!('sys2', 'usr2', { signal: ac.signal });
    expect(posted.at(-1)).toMatchObject({ type: 'llm-request', requestId: 2 });
    ac.abort();
    expect(posted.at(-1)).toEqual({ type: 'llm-cancel', requestId: 2 });
    emit({ type: 'llm-error', requestId: 2, error: 'aborted' });
    await expect(p2).rejects.toThrow('aborted');
  });
});
