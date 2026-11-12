import { describe, expect, it } from 'vitest';
import { PRODUCT_SURFACE_INVENTORY, type ProductSurfaceDomain } from '../shared/productSurfaces';
import { IPC_CHANNELS } from '../shared/types';
import {
  AUTHORITATIVE_COVERAGE_SOURCES,
  auditAuthorityCoverage,
  BUILTIN_AGENT_TYPE_COVERAGE,
  BUILTIN_AGENT_TYPE_IDS,
  BUILTIN_TOOL_COVERAGE,
  BUILTIN_TOOL_IDS,
  type CoverageDisposition,
  IPC_PRODUCT_COVERAGE,
} from './productCapabilityCoverage.fixture';

const sortedKeys = (value: object): string[] => Object.keys(value).sort();

function expectValidDispositions(source: Readonly<Record<string, CoverageDisposition>>): void {
  for (const [authorityId, disposition] of Object.entries(source)) {
    if (disposition.kind === 'excluded') {
      expect(disposition.reason.trim(), authorityId).not.toBe('');
      continue;
    }
    for (const surfaceId of disposition.surfaceIds) {
      expect(PRODUCT_SURFACE_INVENTORY, authorityId).toHaveProperty(surfaceId);
    }
  }
}

describe('product capability coverage', () => {
  it('覆盖全部当前用户可见领域', () => {
    const expectedDomains: ProductSurfaceDomain[] = [
      'general',
      'appearance',
      'providers',
      'skills',
      'mcp',
      'instructions',
      'presets',
      'agent-types',
      'tools',
      'onboarding',
      'projects',
      'conversations',
      'team',
      'updates',
      'window',
      'coding-tools',
    ];
    expect(
      [...new Set(Object.values(PRODUCT_SURFACE_INVENTORY).map((item) => item.domain))].sort()
    ).toEqual(expectedDomains.sort());
  });

  it('SettingsState keys/actions、builtin manifests、IPC 常量均有派生覆盖', () => {
    for (const source of Object.values(AUTHORITATIVE_COVERAGE_SOURCES)) {
      expectValidDispositions(source);
    }
    expect(sortedKeys(BUILTIN_TOOL_COVERAGE)).toEqual([...BUILTIN_TOOL_IDS].sort());
    expect(sortedKeys(BUILTIN_AGENT_TYPE_COVERAGE)).toEqual([...BUILTIN_AGENT_TYPE_IDS].sort());
    expect(sortedKeys(IPC_PRODUCT_COVERAGE)).toEqual(sortedKeys(IPC_CHANNELS));
    expect(auditAuthorityCoverage(BUILTIN_TOOL_IDS, BUILTIN_TOOL_COVERAGE)).toEqual([]);
    expect(auditAuthorityCoverage(BUILTIN_AGENT_TYPE_IDS, BUILTIN_AGENT_TYPE_COVERAGE)).toEqual([]);
    expect(auditAuthorityCoverage(Object.keys(IPC_CHANNELS), IPC_PRODUCT_COVERAGE)).toEqual([]);
  });

  it('负测：漏 builtin tool/type 或 IPC 常量覆盖会被门禁抓住', () => {
    const tools: Record<string, CoverageDisposition> = { ...BUILTIN_TOOL_COVERAGE };
    delete tools.subagent;
    expect(auditAuthorityCoverage(BUILTIN_TOOL_IDS, tools)).toContain(
      'missing authority coverage: subagent'
    );

    const agentTypes: Record<string, CoverageDisposition> = {
      ...BUILTIN_AGENT_TYPE_COVERAGE,
    };
    delete agentTypes.reviewer;
    expect(auditAuthorityCoverage(BUILTIN_AGENT_TYPE_IDS, agentTypes)).toContain(
      'missing authority coverage: reviewer'
    );

    const ipc: Record<string, CoverageDisposition> = { ...IPC_PRODUCT_COVERAGE };
    delete ipc.AGENT_SNAPSHOT;
    expect(auditAuthorityCoverage(Object.keys(IPC_CHANNELS), ipc)).toContain(
      'missing authority coverage: AGENT_SNAPSHOT'
    );
  });

  it('deterministic Agent dispatch IPC 名称稳定且无旧 Enso 能力通道', () => {
    expect(IPC_CHANNELS.AGENT_TYPES_REGISTRY_LIST).toBe('agent-types:registry-list');
    expect(IPC_CHANNELS.AGENT_MODEL_SELECTION_REGISTER).toBe(
      'agent-dispatch:model-selection-register'
    );
    expect(IPC_CHANNELS.AGENT_DISPATCH_BIND_SOURCE).toBe('agent-dispatch:bind-source');
    expect(IPC_CHANNELS.AGENT_DISPATCH).toBe('agent-dispatch:dispatch');
    expect(IPC_CHANNELS.AGENT_DISPATCH_EVENT).toBe('agent-dispatch:event');
    expect(IPC_CHANNELS).not.toHaveProperty('AGENT_SUMMON');
    expect(IPC_CHANNELS).not.toHaveProperty('AGENT_COMPOSER_PREFILL');
    expect(IPC_CHANNELS.SOURCE_AUTHORITY_READ).toBe('source-authority:read');
    expect(IPC_CHANNELS.SOURCE_AUTHORITY_CHANGED).toBe('source-authority:changed');
    expect(IPC_CHANNELS.SOURCE_PROJECT_CREATE).toBe('source-authority:project-create');
    expect(IPC_CHANNELS.SOURCE_CONVERSATION_CREATE).toBe('source-authority:conversation-create');
    expect(IPC_CHANNELS.SOURCE_CONVERSATION_UPDATE_SELECTION).toBe(
      'source-authority:conversation-update-selection'
    );
    expect(Object.keys(IPC_CHANNELS).some((key) => key.startsWith('BUILTIN_AGENTS_'))).toBe(false);
    expect(IPC_CHANNELS).not.toHaveProperty('CAPABILITIES_RESULT');
    expect(IPC_CHANNELS).not.toHaveProperty('CAPABILITIES_ASK');
    expect(IPC_CHANNELS).not.toHaveProperty('CAPABILITIES_RESPOND');
  });
});
