import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { AGY_PLACEHOLDER_API_KEY, AGY_PROVIDER_ID } from '@shared/agy/constants';
import type { PiContext, PiModel } from '@shared/providers/piProviderTypes';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalGate } from '../approval';
import { agyProviderConfig, streamAgy } from './provider';
import { closeAllAgySessions } from './registry';
import { setAgySessionOpener } from './runtimeHost';
import type { AgySession, AgyTurnInput, AgyTurnResult } from './session';
import { attachAgyBridgeToSession } from './sessionBridge';

afterEach(async () => {
  setAgySessionOpener(undefined);
  await closeAllAgySessions();
});

describe('agy provider stream', () => {
  it('registers a placeholder key and does not hand agy tool calls back to pi', async () => {
    expect(agyProviderConfig().apiKey).toBe(AGY_PLACEHOLDER_API_KEY);
    expect(agyProviderConfig().models?.some((model) => model.id === 'default')).toBe(true);

    setAgySessionOpener(async () =>
      fakeSession(async (input) => {
        input.onEvent?.({ type: 'text', delta: 'done' });
        input.onEvent?.({
          type: 'tool',
          id: 'read-1',
          name: 'read_file',
          status: 'completed',
          args: { path: 'a.ts' },
        });
        return {
          stopReason: 'stop',
          text: 'done',
          thinking: '',
          tools: [{ id: 'read-1', name: 'read_file', status: 'completed', args: { path: 'a.ts' } }],
          sessionId: 'agy-1',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
        };
      })
    );

    const dir = mkdtempSync(path.join(tmpdir(), 'agy-provider-'));
    const events: { type: string }[] = [];
    const session = fakeAgentSession(events);
    attachAgyBridgeToSession(session, {
      ensoSessionId: 'enso-1',
      cwd: '/work',
      sessionDir: dir,
      clientVersion: '0.3.14',
      gate: new ApprovalGate(
        'full',
        () => {},
        () => {}
      ),
      planActive: () => false,
      readRoots: () => ['/work'],
    });
    session.subscribe(() => {});
    await session.prompt('fix it');
    const message = events.find((event) => event.type === 'done') as
      | { message?: { content?: { type: string }[] } }
      | undefined;
    expect(message?.message?.content?.some((part) => part.type === 'toolCall')).toBe(false);
    (session as unknown as { emit(event: { type: string }): void }).emit({ type: 'agent_end' });
    expect(session.messages.at(-1)).toMatchObject({ role: 'toolResult', toolName: 'read_file' });
    const assistant = session.messages.find(
      (entry) => (entry as { role?: string }).role === 'assistant'
    ) as {
      content: { type: string; name?: string }[];
    };
    expect(
      assistant.content.some((part) => part.type === 'toolCall' && part.name === 'read_file')
    ).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

function fakeSession(turn: (input: AgyTurnInput) => Promise<AgyTurnResult>): AgySession {
  return {
    phase: () => ({
      phase: 'session-ready',
      sessionId: 'agy-1',
      version: '1.5.18',
      canAppendSystemPrompt: true,
      configOptions: [],
      modes: [],
    }),
    sessionId: () => 'agy-1',
    resumed: false,
    turn,
    close: async () => {},
  };
}

function fakeAgentSession(events: { type: string }[]): AgentSession {
  const listeners = new Set<(event: { type: string }) => void>();
  const session = {
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      },
    ],
    thinkingLevel: 'off',
    subscribe(listener: (event: { type: string }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: { type: string }) {
      for (const listener of listeners) listener(event);
    },
    async prompt() {
      const stream = streamAgy(model(), context(), {});
      for await (const event of stream) events.push(event as { type: string });
    },
    async steer() {},
    dispose() {},
  };
  return session as unknown as AgentSession;
}

function model(): PiModel {
  return {
    id: 'default',
    name: 'agy cli',
    provider: AGY_PROVIDER_ID,
    api: 'agy-acp',
  } as PiModel;
}

function context(): PiContext {
  return {
    messages: [
      { role: 'system', content: 'You are a coding assistant running inside pi' },
      { role: 'user', content: 'fix it' },
    ],
  } as unknown as PiContext;
}
