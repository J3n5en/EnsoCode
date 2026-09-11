import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetLocalChatForTest, createLocalComplete, memoryCompleteFromSettings } from './chat';
import type { LocalInferenceDiag } from './inferenceDiag';
import type { LlamaModelLike } from './runtime';

function fakeModel(): LlamaModelLike {
  return {
    createEmbeddingContext: vi.fn(),
    createContext: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}

afterEach(() => {
  vi.useRealTimers();
  __resetLocalChatForTest();
});

describe('createLocalComplete', () => {
  it('returns the session text as-is, including markdown fences', async () => {
    const complete = createLocalComplete('/m/a.gguf', {
      acquireModelImpl: async () => fakeModel(),
      createSession: async (_model, systemPrompt) => ({
        prompt: async (user) =>
          `\`\`\`json\n{"ok":true,"system":${JSON.stringify(systemPrompt)},"user":${JSON.stringify(user)}}\n\`\`\``,
        dispose: () => {},
      }),
    });
    const text = await complete('sys', 'user-1');
    expect(text).toContain('```json');
    expect(text).toContain('user-1');
  });

  it('logs token meter and thought counts on local inference without any prompt text', async () => {
    const lines: unknown[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((...args) => {
      lines.push(args);
    });
    const complete = createLocalComplete('/m/a.gguf', {
      acquireModelImpl: async () => fakeModel(),
      createSession: async () => {
        const session: {
          lastDiag?: LocalInferenceDiag;
          prompt: () => Promise<string>;
          dispose: () => void;
        } = {
          prompt: async () => {
            session.lastDiag = {
              inputTokens: 41,
              outputTokens: 17,
              firstTokenMs: 12,
              promptMs: 90,
              thoughtChars: 8,
              thoughtTokens: 3,
              gpu: 'metal',
              gpuLayers: 33,
              flashAttentionConfig: 'auto',
              finalTextChars: 19,
            };
            return 'VISIBLE_SECRET_JSON';
          },
          dispose: () => {},
        };
        return session;
      },
    });
    await complete('system-secret', 'user-secret', { maxTokens: 1536, stage: 'extract' });
    spy.mockRestore();
    const inf = lines.find(
      (row) => Array.isArray(row) && row[0] === '[memory-distill] local inference'
    ) as [string, Record<string, unknown>] | undefined;
    expect(inf?.[1]).toMatchObject({
      stage: 'extract',
      maxTokens: 1536,
      inputTokens: 41,
      outputTokens: 17,
      firstTokenMs: 12,
      promptMs: 90,
      thoughtChars: 8,
      thoughtTokens: 3,
      gpu: 'metal',
      gpuLayers: 33,
      flashAttentionConfig: 'auto',
      finalTextChars: 19,
    });
    const dumped = JSON.stringify(lines);
    expect(dumped).not.toContain('user-secret');
    expect(dumped).not.toContain('system-secret');
    expect(dumped).not.toContain('VISIBLE_SECRET');
  });

  it('passes a per-call output budget to the local session prompt', async () => {
    const promptOptions: unknown[] = [];
    const complete = createLocalComplete('/m/a.gguf', {
      acquireModelImpl: async () => fakeModel(),
      createSession: async () => ({
        prompt: async (_user, options) => {
          promptOptions.push(options);
          return 'ok';
        },
        dispose: () => {},
      }),
    });
    await complete('sys', 'user', { maxTokens: 1536, stage: 'consolidate' });
    expect(promptOptions).toEqual([
      expect.objectContaining({ maxTokens: 1536, signal: expect.any(AbortSignal) }),
    ]);
  });

  it('creates a new session per call so concurrent insight cannot inherit distill history', async () => {
    const systems: string[] = [];
    const complete = createLocalComplete('/m/a.gguf', {
      acquireModelImpl: async () => fakeModel(),
      createSession: async (_model, systemPrompt) => {
        systems.push(systemPrompt);
        return {
          prompt: async (user) => `${systemPrompt}:${user}`,
          dispose: () => {},
        };
      },
    });
    expect(await complete('distill', 'a')).toBe('distill:a');
    expect(await complete('insight', 'b')).toBe('insight:b');
    expect(systems).toEqual(['distill', 'insight']);
  });

  it('serializes overlapping calls against one llama.cpp sequence', async () => {
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered = false;
    const complete = createLocalComplete('/m/a.gguf', {
      acquireModelImpl: async () => fakeModel(),
      createSession: async () => ({
        prompt: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (!firstEntered) {
            firstEntered = true;
            await firstHold;
          }
          active -= 1;
          return 'ok';
        },
        dispose: () => {},
      }),
    });
    const a = complete('s', '1');
    const b = complete('s', '2');
    await vi.waitFor(() => expect(firstEntered).toBe(true));
    expect(maxActive).toBe(1);
    releaseFirst();
    await expect(Promise.all([a, b])).resolves.toEqual(['ok', 'ok']);
    expect(maxActive).toBe(1);
  });

  it('aborts a stuck generation when the timeout fires', async () => {
    const complete = createLocalComplete('/m/a.gguf', {
      timeoutMs: 20,
      acquireModelImpl: async () => fakeModel(),
      createSession: async () => ({
        prompt: async (_user, opts) =>
          new Promise<string>((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
        dispose: () => {},
      }),
    });
    await expect(complete('s', 'u')).rejects.toThrow(/aborted|timed out/i);
  });
});

describe('memoryCompleteFromSettings', () => {
  it('uses the remote complete when the setting is remote or absent', async () => {
    const remote = async () => async () => 'remote-text';
    const fromAbsent = await memoryCompleteFromSettings(undefined, {
      modelsRoot: '/missing',
      remoteComplete: remote,
    });
    expect(fromAbsent).not.toBeNull();
    expect(await fromAbsent!('s', 'u')).toBe('remote-text');

    const fromRemote = await memoryCompleteFromSettings(
      { memoryChatModel: 'remote' },
      { modelsRoot: '/missing', remoteComplete: remote }
    );
    expect(await fromRemote!('s', 'u')).toBe('remote-text');
  });

  it('returns null for a local model that is not on disk instead of falling back to remote', async () => {
    const remote = vi.fn(async () => async () => 'remote-text');
    const complete = await memoryCompleteFromSettings(
      { memoryChatModel: 'local:gemma-4-e2b' },
      { modelsRoot: '/missing', remoteComplete: remote }
    );
    expect(complete).toBeNull();
    expect(remote).not.toHaveBeenCalled();
  });
});
