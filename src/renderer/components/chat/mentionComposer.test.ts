import type { AgentTypeCandidate } from '@shared/builtinAgents';
import { describe, expect, it } from 'vitest';
import {
  flattenMentionGroups,
  flattenMentionRoot,
  groupMentionCandidates,
  toAgentMentionCandidates,
  toFileMentionCandidates,
} from '../../hooks/useMentionSearch';
import {
  createComposerPayload,
  extractMentionQuery,
  resolvePopupKeyAction,
  unresolvedMentionToken,
} from './mentionComposer';

const registry: AgentTypeCandidate[] = [
  {
    typeKey: 'agent:enso',
    displayName: 'Enso',
    description: 'EnsoCode system agent for product capabilities and team setup',
    source: 'system',
    locked: true,
    canDisable: false,
    canEdit: false,
  },
  {
    typeKey: 'builtin:scout',
    displayName: 'Scout',
    description: 'Fast repository reconnaissance',
    source: 'builtin',
    locked: false,
    canDisable: true,
    canEdit: false,
  },
  {
    typeKey: 'builtin:reviewer',
    displayName: 'Review',
    description: 'Built-in review',
    source: 'builtin',
    locked: false,
    canDisable: true,
    canEdit: false,
  },
  {
    typeKey: 'custom:123e4567-e89b-42d3-a456-426614174000',
    displayName: 'Review',
    description: 'Custom review',
    source: 'custom',
    locked: false,
    canDisable: false,
    canEdit: true,
  },
];
const agents = toAgentMentionCandidates(registry);
const duplicateNames = toFileMentionCandidates([
  { name: 'index.ts', relativePath: 'src/main/index.ts' },
  { name: 'index.ts', relativePath: 'src/renderer/index.ts' },
]);

describe('typed multi-entity mentions', () => {
  it('keeps Main registry order, all legal types, duplicate labels, and Files after Agents', () => {
    const groups = groupMentionCandidates('', agents, duplicateNames);
    expect(groups.agents.map((candidate) => candidate.typeKey)).toEqual([
      'agent:enso',
      'builtin:scout',
      'builtin:reviewer',
      'custom:123e4567-e89b-42d3-a456-426614174000',
    ]);
    expect(groups.agents.filter((candidate) => candidate.label === 'Review')).toMatchObject([
      { source: 'builtin', typeKey: 'builtin:reviewer' },
      {
        source: 'custom',
        typeKey: 'custom:123e4567-e89b-42d3-a456-426614174000',
      },
    ]);
    expect(flattenMentionGroups(groups).map((item) => item.group)).toEqual([
      'agents',
      'agents',
      'agents',
      'agents',
      'files',
      'files',
    ]);
  });

  it('nests Agents as a folder on empty query and flattens agents when searching', () => {
    const groups = groupMentionCandidates('', agents, duplicateNames);
    expect(flattenMentionRoot(groups, '')).toEqual([
      { type: 'folder', id: 'agents' },
      {
        type: 'item',
        group: 'files',
        candidate: duplicateNames[0],
      },
      {
        type: 'item',
        group: 'files',
        candidate: duplicateNames[1],
      },
    ]);
    expect(flattenMentionRoot(groups, '  ')).toEqual(flattenMentionRoot(groups, ''));
    const filesOnly = groupMentionCandidates('', [], duplicateNames);
    expect(flattenMentionRoot(filesOnly, '').every((item) => item.type === 'item')).toBe(true);
    const searched = groupMentionCandidates('scout', agents, duplicateNames);
    expect(flattenMentionRoot(searched, 'scout')).toEqual([
      { type: 'item', group: 'agents', candidate: agents[1] },
    ]);
  });

  it('keeps duplicate file names distinguishable by relative path', () => {
    expect(duplicateNames).toEqual([
      {
        kind: 'file',
        id: 'src/main/index.ts',
        label: 'index.ts',
        relativePath: 'src/main/index.ts',
      },
      {
        kind: 'file',
        id: 'src/renderer/index.ts',
        label: 'index.ts',
        relativePath: 'src/renderer/index.ts',
      },
    ]);
  });

  it('detects only cursor-local mention tokens and refuses unresolved tokens', () => {
    expect(extractMentionQuery('hello @Ens', 10)).toBe('Ens');
    expect(extractMentionQuery('mail@example.com', 16)).toBeNull();
    expect(unresolvedMentionToken('review @src/main/index.ts', duplicateNames)).toBeNull();
    const spacedPath = toFileMentionCandidates([
      { name: 'design notes.md', relativePath: 'docs/design notes.md' },
    ]);
    expect(unresolvedMentionToken('review @docs/design notes.md', spacedPath)).toBeNull();
    expect(unresolvedMentionToken('review @not-selected.ts', duplicateNames)).toBe(
      'not-selected.ts'
    );
  });

  it('supports wraparound keyboard selection, Tab, Escape, and IME-safe Enter', () => {
    expect(
      resolvePopupKeyAction({
        key: 'ArrowUp',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
      })
    ).toEqual({ type: 'move', index: 2 });
    expect(
      resolvePopupKeyAction({
        key: 'Tab',
        shiftKey: false,
        isComposing: false,
        activeIndex: 1,
        itemCount: 3,
      })
    ).toEqual({ type: 'pick' });
    expect(
      resolvePopupKeyAction({
        key: 'Escape',
        shiftKey: false,
        isComposing: false,
        activeIndex: 1,
        itemCount: 3,
      })
    ).toEqual({ type: 'close' });
    expect(
      resolvePopupKeyAction({
        key: 'Enter',
        shiftKey: false,
        isComposing: true,
        activeIndex: 1,
        itemCount: 3,
      })
    ).toEqual({ type: 'none' });
  });

  it('opens, navigates, and closes the Agents folder without picking the parent row', () => {
    expect(
      resolvePopupKeyAction({
        key: 'Enter',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        activeIsFolder: true,
      })
    ).toEqual({ type: 'open-folder' });
    expect(
      resolvePopupKeyAction({
        key: 'ArrowRight',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        activeIsFolder: true,
      })
    ).toEqual({ type: 'open-folder' });
    expect(
      resolvePopupKeyAction({
        key: 'ArrowDown',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        folderOpen: true,
        folderIndex: 0,
        folderItemCount: 4,
      })
    ).toEqual({ type: 'move-folder', index: 1 });
    expect(
      resolvePopupKeyAction({
        key: 'ArrowUp',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        folderOpen: true,
        folderIndex: 0,
        folderItemCount: 4,
      })
    ).toEqual({ type: 'move-folder', index: 3 });
    expect(
      resolvePopupKeyAction({
        key: 'Enter',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        folderOpen: true,
        folderIndex: 2,
        folderItemCount: 4,
      })
    ).toEqual({ type: 'pick' });
    expect(
      resolvePopupKeyAction({
        key: 'Escape',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        folderOpen: true,
        folderIndex: 1,
        folderItemCount: 4,
      })
    ).toEqual({ type: 'close-folder' });
    expect(
      resolvePopupKeyAction({
        key: 'ArrowLeft',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        folderOpen: true,
        folderIndex: 1,
        folderItemCount: 4,
      })
    ).toEqual({ type: 'close-folder' });
    // 候选异步变空时 Escape 仍要能退出 folder，否则根级 close 永远走不到，弹窗死锁
    expect(
      resolvePopupKeyAction({
        key: 'Escape',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        folderOpen: true,
        folderIndex: 0,
        folderItemCount: 0,
      })
    ).toEqual({ type: 'close-folder' });
  });

  it('builds a typed recipient payload with explicit file context', () => {
    const payload = createComposerPayload({
      text: 'summarize @src/main/index.ts',
      slash: null,
      images: [],
      mentions: [duplicateNames[0], agents[1]],
      recipient: agents[1],
    });
    expect(payload.recipient).toMatchObject({
      kind: 'agent-type',
      typeKey: 'builtin:scout',
    });
    expect(payload.mentions[0]).toMatchObject({ kind: 'file', id: 'src/main/index.ts' });
  });
});
