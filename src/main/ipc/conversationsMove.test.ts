import type { ConversationAuthorityProjection } from '@shared/types/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  conversationIdsToMove,
  handleConversationsMove,
  parseMoveConversationInput,
} from './conversationsMove';

const conversation = (projectId: string): ConversationAuthorityProjection => ({
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId,
  kind: 'root',
  lifecycle: 'ready',
  version: 2,
});

describe('parseMoveConversationInput', () => {
  it('rejects missing fields and wrong types', () => {
    expect(parseMoveConversationInput(undefined)).toBeNull();
    expect(parseMoveConversationInput(null)).toBeNull();
    expect(parseMoveConversationInput('x')).toBeNull();
    expect(parseMoveConversationInput({})).toBeNull();
    expect(parseMoveConversationInput({ conversationId: 'a' })).toBeNull();
    expect(parseMoveConversationInput({ targetProjectId: 'b' })).toBeNull();
    expect(parseMoveConversationInput({ conversationId: 1, targetProjectId: 'b' })).toBeNull();
    expect(parseMoveConversationInput({ conversationId: 'a', targetProjectId: '' })).toBeNull();
    expect(
      parseMoveConversationInput({ conversationId: 'a', targetProjectId: 'b', extra: 1 })
    ).toBeNull();
  });

  it('accepts the two identifiers', () => {
    expect(parseMoveConversationInput({ conversationId: 'a', targetProjectId: 'b' })).toEqual({
      conversationId: 'a',
      targetProjectId: 'b',
    });
  });
});

describe('conversationIdsToMove', () => {
  it('includes parentId and btwParentId descendants', () => {
    expect(
      conversationIdsToMove(
        {
          root: {},
          child: { parentId: 'root' },
          nested: { parentId: 'child' },
          btw: { btwParentId: 'root' },
          other: { parentId: 'x' },
        },
        'root'
      ).sort()
    ).toEqual(['btw', 'child', 'nested', 'root']);
  });
});

describe('handleConversationsMove', () => {
  const target = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const input = {
    conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    targetProjectId: target,
  };

  it('returns invalid for bad input without touching ports', () => {
    const ports = {
      moveConversation: vi.fn(),
      isRunning: vi.fn(() => false),
      readConversations: vi.fn(() => ({})),
      patchProjectIds: vi.fn(),
    };
    expect(handleConversationsMove({ conversationId: 'a' }, ports)).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(ports.moveConversation).not.toHaveBeenCalled();
    expect(ports.patchProjectIds).not.toHaveBeenCalled();
  });

  it('returns not-found for an unknown conversationId', () => {
    const ports = {
      moveConversation: vi.fn(() => ({ accepted: false as const, error: 'not-found' })),
      isRunning: vi.fn(() => false),
      readConversations: vi.fn(() => ({})),
      patchProjectIds: vi.fn(),
    };
    expect(handleConversationsMove(input, ports)).toEqual({ ok: false, error: 'not-found' });
    expect(ports.patchProjectIds).not.toHaveBeenCalled();
  });

  it('patches the root and child rows after a successful move', () => {
    const value = conversation(target);
    const ports = {
      moveConversation: vi.fn(() => ({ accepted: true as const, value })),
      isRunning: vi.fn(() => false),
      readConversations: vi.fn(() => ({
        [input.conversationId]: { projectId: 'old' },
        child: { parentId: input.conversationId, projectId: 'old' },
      })),
      patchProjectIds: vi.fn(),
    };
    expect(handleConversationsMove(input, ports)).toEqual({ ok: true, value });
    expect(ports.moveConversation).toHaveBeenCalledWith(input.conversationId, target, {
      running: false,
    });
    expect(ports.patchProjectIds).toHaveBeenCalledWith(
      expect.arrayContaining([input.conversationId, 'child']),
      target
    );
  });

  it('forwards the running flag and does not patch on rejection', () => {
    const ports = {
      moveConversation: vi.fn(() => ({ accepted: false as const, error: 'running' })),
      isRunning: vi.fn(() => true),
      readConversations: vi.fn(() => ({})),
      patchProjectIds: vi.fn(),
    };
    expect(handleConversationsMove(input, ports)).toEqual({ ok: false, error: 'running' });
    expect(ports.moveConversation).toHaveBeenCalledWith(input.conversationId, target, {
      running: true,
    });
    expect(ports.patchProjectIds).not.toHaveBeenCalled();
  });
});
