import { describe, expect, it } from 'vitest';
import type { AgentTypeKey } from '../builtinAgents';
import {
  parseAgentComposerPrefillEvent,
  parseAgentDispatchRequest,
  parseAgentSummonRequest,
  parseMainModelSelectionBinding,
  parseMentionCandidate,
  parseParentModelSelectionRequest,
  parseParentSourceBindingRequest,
} from './mentions';

const known = new Set<AgentTypeKey>([
  'agent:enso',
  'builtin:scout',
  'custom:11111111-1111-4111-8111-111111111111',
]);

const dispatch = {
  requestId: 'dispatch-1',
  selectionBindingId: 'selection-binding-1',
  typeKey: 'agent:enso',
  task: {
    text: 'Review this file',
    images: [],
    fileMentions: [{ id: 'file-1', relativePath: 'src/a.ts' }],
  },
};

describe('Agent dispatch strict transport', () => {
  it('dispatch 只接受 selectionBindingId/typeKey/task 与 registry 已知 key', () => {
    expect(parseAgentDispatchRequest(dispatch, known)).toEqual(dispatch);
    expect(
      parseAgentDispatchRequest({ ...dispatch, typeKey: 'builtin:unknown' }, known)
    ).toBeNull();
    expect(parseAgentDispatchRequest({ ...dispatch, typeKey: 'custom:enso' }, known)).toBeNull();
  });

  it('夹带 target/profile/session/model/name 等任何额外字段全部拒绝', () => {
    for (const field of [
      'conversationId',
      'projectPath',
      'sessionId',
      'generation',
      'profileId',
      'model',
      'tools',
      'skills',
      'mcpServers',
      'instanceName',
      'name',
    ]) {
      expect(
        parseAgentDispatchRequest({ ...dispatch, [field]: 'forged' }, known),
        field
      ).toBeNull();
    }
  });

  it('task 至少有 text/image，file mention 与 image 都严格收窄', () => {
    expect(
      parseAgentDispatchRequest(
        { ...dispatch, task: { text: '', images: [], fileMentions: [] } },
        known
      )
    ).toBeNull();
    expect(
      parseAgentDispatchRequest(
        {
          ...dispatch,
          task: {
            text: '',
            images: [{ data: 'base64', mimeType: 'image/png' }],
            fileMentions: [],
          },
        },
        known
      )
    ).not.toBeNull();
    expect(
      parseAgentDispatchRequest(
        {
          ...dispatch,
          task: {
            text: 'x',
            images: [],
            fileMentions: [{ id: 'f', relativePath: '../escape', projectPath: '/tmp' }],
          },
        },
        known
      )
    ).toBeNull();
  });

  it('D21 selector→Main binding 单一合同，dispatch 不直接携 selectedModel', () => {
    const selectionRequest = {
      parentBindingId: 'parent-binding-1',
      selection: { providerId: 'settings-provider-entry', modelId: 'model-1' },
    };
    expect(parseParentModelSelectionRequest(selectionRequest)).toEqual(selectionRequest);
    expect(
      parseParentModelSelectionRequest({
        ...selectionRequest,
        available: true,
      })
    ).toBeNull();
    expect(
      parseParentModelSelectionRequest({
        ...selectionRequest,
        selection: { providerId: '', modelId: 'model-1' },
      })
    ).toBeNull();

    for (const source of ['started-session', 'draft-selection', 'default', 'legacy']) {
      const binding = {
        selectionBindingId: 'selection-binding-1',
        parentBindingId: 'parent-binding-1',
        providerId: 'settings-provider-entry',
        modelId: 'model-1',
        mainRevision: 4,
        source,
        issuedAt: 1,
      };
      expect(parseMainModelSelectionBinding(binding), source).toEqual(binding);
    }
    expect(
      parseMainModelSelectionBinding({
        selectionBindingId: 'selection-binding-1',
        parentBindingId: 'parent-binding-1',
        providerId: 'p',
        modelId: 'm',
        mainRevision: -1,
        source: 'renderer-claimed',
        issuedAt: 1,
      })
    ).toBeNull();

    expect(parseParentSourceBindingRequest({ requestId: 'b1' })).not.toBeNull();
    expect(
      parseParentSourceBindingRequest({
        requestId: 'b1',
        selectedModel: selectionRequest.selection,
      })
    ).toBeNull();
    expect(
      parseAgentDispatchRequest({ ...dispatch, selectedModel: selectionRequest.selection }, known)
    ).toBeNull();
    expect(parseAgentDispatchRequest({ ...dispatch, mainRevision: 4 }, known)).toBeNull();
    expect(parseAgentSummonRequest({ typeKey: 'agent:enso' }, known)).not.toBeNull();
    expect(parseAgentSummonRequest({ typeKey: 'agent:enso', prompt: 'hello' }, known)).toEqual({
      typeKey: 'agent:enso',
      prompt: 'hello',
    });
    expect(parseAgentSummonRequest({ typeKey: 'builtin:unknown' }, known)).toBeNull();
    expect(parseAgentComposerPrefillEvent({ typeKey: 'agent:enso' })).not.toBeNull();
    expect(parseAgentComposerPrefillEvent({ typeKey: 'agent:enso', prompt: 'hi' })).toEqual({
      typeKey: 'agent:enso',
      prompt: 'hi',
    });
  });

  it('mention candidate 支持 system/builtin/custom AgentType，不接受实例名路由', () => {
    const base = {
      kind: 'agent-type',
      label: 'Scout',
      displayName: 'Scout',
      description: 'Scout',
      locked: false,
      canDisable: true,
      canEdit: false,
    };
    expect(
      parseMentionCandidate({
        ...base,
        id: 'builtin:scout',
        typeKey: 'builtin:scout',
        source: 'builtin',
      })
    ).not.toBeNull();
    expect(
      parseMentionCandidate({
        ...base,
        id: 'custom:11111111-1111-4111-8111-111111111111',
        typeKey: 'custom:11111111-1111-4111-8111-111111111111',
        source: 'custom',
        canDisable: false,
        canEdit: true,
      })
    ).not.toBeNull();
    expect(parseMentionCandidate({ ...base, id: 'reviewer', typeKey: 'reviewer' })).toBeNull();
  });

  it('parses chat mention candidates with a strict shape', () => {
    const chat = { kind: 'chat', id: 'c1', label: 'fix login', sessionFile: '/s/c1.jsonl' };
    expect(parseMentionCandidate(chat)).toEqual(chat);
    expect(parseMentionCandidate({ ...chat, sessionFile: '' })).toBeNull();
    expect(parseMentionCandidate({ ...chat, extra: 1 })).toBeNull();
    expect(parseMentionCandidate({ kind: 'chat', id: 'c1', label: 'x' })).toBeNull();
  });

  it('parses ui-element mention candidates with a strict shape (Design Mode 只走插入，不进 picker)', () => {
    const ui = {
      kind: 'ui-element',
      id: 'ui-1',
      label: 'SubmitButton',
      path: 'main > form > button:nth-of-type(2)',
      text: 'Submit',
      imageId: 'img-1',
    };
    expect(parseMentionCandidate(ui)).toEqual(ui);
    for (const field of ['id', 'label', 'path', 'text', 'imageId'] as const) {
      expect(parseMentionCandidate({ ...ui, [field]: '' }), field).toBeNull();
      expect(parseMentionCandidate({ ...ui, [field]: 1 }), field).toBeNull();
      const { [field]: _dropped, ...missing } = ui;
      expect(parseMentionCandidate(missing), `missing ${field}`).toBeNull();
    }
    expect(parseMentionCandidate({ ...ui, rect: { x: 0, y: 0, width: 1, height: 1 } })).toBeNull();
  });
});
