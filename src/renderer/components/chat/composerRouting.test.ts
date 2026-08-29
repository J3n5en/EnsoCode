import type { AgentTypeKey } from '@shared/builtinAgents';
import { describe, expect, it, vi } from 'vitest';
import { routeComposerPayload } from './composerRouting';
import type { ComposerPayload } from './mentionComposer';

const payloadFor = (typeKey: AgentTypeKey): ComposerPayload => {
  const recipient = {
    kind: 'agent-type' as const,
    id: typeKey,
    typeKey,
    label: typeKey,
    displayName: typeKey,
    description: 'Agent description',
    source: (typeKey === 'agent:enso' ? 'system' : 'builtin') as 'system' | 'builtin',
    locked: typeKey === 'agent:enso',
    canDisable: typeKey !== 'agent:enso',
    canEdit: false,
  };
  return {
    text: 'do the task',
    images: [],
    mentions: [
      {
        kind: 'file',
        id: 'src/main/index.ts',
        label: 'index.ts',
        relativePath: 'src/main/index.ts',
      },
      recipient,
    ],
    recipient,
  };
};

describe('Composer typed recipient routing', () => {
  it.each<AgentTypeKey>([
    'agent:enso',
    'builtin:scout',
    'custom:123e4567-e89b-42d3-a456-426614174000',
  ])('dispatches typed recipient %s and never calls coding send', (typeKey) => {
    const dispatchAgent = vi.fn();
    const sendCoding = vi.fn();
    expect(routeComposerPayload(payloadFor(typeKey), { dispatchAgent, sendCoding })).toBe('agent');
    expect(dispatchAgent).toHaveBeenCalledWith(typeKey, {
      text: 'do the task',
      images: [],
      fileMentions: [{ id: 'src/main/index.ts', relativePath: 'src/main/index.ts' }],
    });
    expect(sendCoding).not.toHaveBeenCalled();
  });

  it('keeps ordinary payload behavior on the existing coding send', () => {
    const dispatchAgent = vi.fn();
    const sendCoding = vi.fn();
    const payload: ComposerPayload = { text: 'hello', images: [], mentions: [] };
    expect(routeComposerPayload(payload, { dispatchAgent, sendCoding })).toBe('coding');
    expect(sendCoding).toHaveBeenCalledWith('hello', []);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });
});
