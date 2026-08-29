import { describe, expect, it } from 'vitest';
import { CAPABILITY_CATALOG, CAPABILITY_HANDLER_CONTRACT } from '../shared/capabilities/catalog';
import type { CapabilitySpec } from '../shared/capabilities/types';
import { PRODUCT_SURFACE_INVENTORY, type ProductSurfaceDomain } from '../shared/productSurfaces';
import { IPC_CHANNELS } from '../shared/types';
import {
  AUTHORITATIVE_COVERAGE_SOURCES,
  auditAuthorityCoverage,
  auditCapabilityContract,
  BUILTIN_AGENT_TYPE_COVERAGE,
  BUILTIN_AGENT_TYPE_IDS,
  BUILTIN_TOOL_COVERAGE,
  BUILTIN_TOOL_IDS,
  type CoverageDisposition,
  IPC_PRODUCT_COVERAGE,
  matchesJsonSchema,
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
      expect(CAPABILITY_CATALOG, authorityId).toHaveProperty(surfaceId);
    }
  }
}

describe('product capability coverage', () => {
  it('inventory → catalog → handler 合同逐 id 完整', () => {
    expect(sortedKeys(CAPABILITY_CATALOG)).toEqual(sortedKeys(PRODUCT_SURFACE_INVENTORY));
    const executableIds = Object.entries(CAPABILITY_CATALOG)
      .filter(([, spec]) => spec.execution.kind === 'executable')
      .map(([id]) => id)
      .sort();
    expect(sortedKeys(CAPABILITY_HANDLER_CONTRACT)).toEqual(executableIds);
    expect(
      auditCapabilityContract({
        inventory: PRODUCT_SURFACE_INVENTORY,
        catalog: CAPABILITY_CATALOG,
        handlerIds: new Set(Object.keys(CAPABILITY_HANDLER_CONTRACT)),
      })
    ).toEqual([]);
  });

  it('spec id/domain/schema 与库存一致', () => {
    for (const [id, spec] of Object.entries(CAPABILITY_CATALOG)) {
      expect(spec.id).toBe(id);
      const inventoryItem = PRODUCT_SURFACE_INVENTORY[id as keyof typeof PRODUCT_SURFACE_INVENTORY];
      expect(spec.domain).toBe(inventoryItem.domain);
      expect(spec.description.trim()).not.toBe('');
      expect(spec.inputSchema).toBeDefined();
    }
  });

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

  it('每项恰为 executable 或 known-unavailable，后者原因与建议动作均非空', () => {
    for (const [id, spec] of Object.entries(CAPABILITY_CATALOG)) {
      if (spec.execution.kind === 'executable') {
        expect(spec.execution.handlerId).toBe(id);
      } else {
        expect(spec.execution.reason.trim(), id).not.toBe('');
        expect(spec.execution.suggestedAction.trim(), id).not.toBe('');
      }
    }
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

  it('会产生最小计费请求的连通性测试必须逐次 ASK', () => {
    expect(CAPABILITY_CATALOG['providers.test-connection'].risk).toBe('dangerous');
  });

  it('Preset create/edit schema 覆盖完整字段并拒绝缺必填、坏数组与额外字段', () => {
    const createSchema = CAPABILITY_CATALOG['presets.create'].inputSchema;
    const editSchema = CAPABILITY_CATALOG['presets.edit'].inputSchema;
    expect(
      matchesJsonSchema(createSchema, {
        name: 'Review',
        skillIds: ['skill-1'],
        mcpServerIds: ['mcp-1'],
        instructionId: 'instruction-1',
      })
    ).toBe(true);
    expect(matchesJsonSchema(createSchema, { skillIds: [] })).toBe(false);
    expect(matchesJsonSchema(createSchema, { name: 'Review', skillIds: [1] })).toBe(false);
    expect(matchesJsonSchema(createSchema, { name: 'Review', unknown: true })).toBe(false);
    expect(
      matchesJsonSchema(editSchema, {
        id: 'preset-1',
        name: 'Updated',
        skillIds: [],
        mcpServerIds: ['mcp-1'],
      })
    ).toBe(true);
    expect(matchesJsonSchema(editSchema, { name: 'Missing id' })).toBe(false);
  });

  it('Agent type create/edit schema 要求模型成对并拒绝未知 tools/额外字段', () => {
    const createSchema = CAPABILITY_CATALOG['agent-types.create'].inputSchema;
    const editSchema = CAPABILITY_CATALOG['agent-types.edit'].inputSchema;
    const model = { providerId: 'provider-1', modelId: 'model-1' };
    expect(
      matchesJsonSchema(createSchema, {
        name: 'reviewer',
        description: 'Review changes',
        systemPrompt: 'Review carefully',
        tools: 'readonly',
        ...model,
        skillIds: ['skill-1'],
        mcpServerIds: [],
      })
    ).toBe(true);
    expect(matchesJsonSchema(createSchema, { name: 'reviewer', providerId: 'p' })).toBe(false);
    expect(matchesJsonSchema(createSchema, { name: 'reviewer', tools: 'dangerous' })).toBe(false);
    expect(matchesJsonSchema(createSchema, { name: 'reviewer', apiKey: 'secret' })).toBe(false);
    expect(matchesJsonSchema(editSchema, { id: 'agent-1', ...model, tools: 'all' })).toBe(true);
    expect(matchesJsonSchema(editSchema, { id: 'agent-1', modelId: 'model-1' })).toBe(false);
    expect(matchesJsonSchema(editSchema, { ...model })).toBe(false);
  });

  it('setting executable schemas 使用真实值域并拒绝重复/未知值', () => {
    expect(
      matchesJsonSchema(CAPABILITY_CATALOG['appearance.theme'].inputSchema, { value: 'dark' })
    ).toBe(true);
    expect(
      matchesJsonSchema(CAPABILITY_CATALOG['appearance.theme'].inputSchema, { value: 'blue' })
    ).toBe(false);
    expect(
      matchesJsonSchema(CAPABILITY_CATALOG['general.language'].inputSchema, { value: 'zh' })
    ).toBe(true);
    expect(
      matchesJsonSchema(CAPABILITY_CATALOG['general.language'].inputSchema, { value: 'fr' })
    ).toBe(false);
    expect(
      matchesJsonSchema(CAPABILITY_CATALOG['appearance.terminal-font-weight'].inputSchema, {
        value: '500',
      })
    ).toBe(true);
    expect(
      matchesJsonSchema(CAPABILITY_CATALOG['appearance.terminal-font-weight'].inputSchema, {
        value: '950',
      })
    ).toBe(false);
    const statusSchema = CAPABILITY_CATALOG['appearance.status-line-segments'].inputSchema;
    expect(matchesJsonSchema(statusSchema, { value: ['model', 'tokens'] })).toBe(true);
    expect(matchesJsonSchema(statusSchema, { value: ['model', 'model'] })).toBe(false);
    expect(matchesJsonSchema(statusSchema, { value: ['unknown-segment'] })).toBe(false);
  });

  it('builtin tool/type 与 team hire/dismiss schemas closed 且字段最小', () => {
    expect(
      matchesJsonSchema(CAPABILITY_CATALOG['tools.toggle-builtin'].inputSchema, {
        id: 'subagent',
        enabled: false,
      })
    ).toBe(true);
    expect(
      matchesJsonSchema(CAPABILITY_CATALOG['tools.toggle-builtin'].inputSchema, {
        id: 'raw-shell',
        enabled: false,
      })
    ).toBe(false);
    expect(
      matchesJsonSchema(CAPABILITY_CATALOG['agent-types.toggle-builtin'].inputSchema, {
        id: 'scout',
        enabled: true,
      })
    ).toBe(true);
    const hireSchema = CAPABILITY_CATALOG['team.hire-coworker'].inputSchema;
    expect(matchesJsonSchema(hireSchema, { name: 'Scout', agentType: 'builtin:scout' })).toBe(true);
    expect(matchesJsonSchema(hireSchema, { name: 'Scout', modelId: 'forged' })).toBe(false);
    const dismissSchema = CAPABILITY_CATALOG['team.dismiss-coworker'].inputSchema;
    expect(matchesJsonSchema(dismissSchema, { coworkerId: 'child-1' })).toBe(true);
    expect(matchesJsonSchema(dismissSchema, { coworkerId: 'child-1', name: 'Forged label' })).toBe(
      false
    );
  });

  it('所有 executable schema 都 closed', () => {
    for (const [id, spec] of Object.entries(CAPABILITY_CATALOG)) {
      if (spec.execution.kind === 'executable') {
        expect(spec.inputSchema.additionalProperties, id).toBe(false);
      }
    }
  });

  it('updates.status 无 Main snapshot getter，必须 known-unavailable 且无 handler', () => {
    const status = CAPABILITY_CATALOG['updates.status'];
    expect(status.execution.kind).toBe('known-unavailable');
    if (status.execution.kind !== 'known-unavailable') throw new Error('invalid fixture');
    expect(status.execution.reason).toContain('renderer event projection');
    expect(status.execution.suggestedAction).toContain('Updates UI');
    expect(CAPABILITY_HANDLER_CONTRACT).not.toHaveProperty('updates.status');
  });

  it('内部 IPC 与任意编码工具不冒充可执行产品能力', () => {
    expect(CAPABILITY_CATALOG).not.toHaveProperty('worker-exited');
    expect(CAPABILITY_CATALOG).not.toHaveProperty(IPC_CHANNELS.SETTINGS_WRITE);
    expect(CAPABILITY_CATALOG).not.toHaveProperty(IPC_CHANNELS.AGENT_SNAPSHOT);
    for (const [id, spec] of Object.entries(CAPABILITY_CATALOG)) {
      if (id.startsWith('coding-tools.')) {
        expect(spec.execution.kind, id).toBe('known-unavailable');
      }
    }
  });

  it('capability 与 deterministic Agent dispatch IPC 名称稳定且无旧 global Enso 通道', () => {
    expect(IPC_CHANNELS.CAPABILITIES_ASK).toBe('capabilities:ask');
    expect(IPC_CHANNELS.CAPABILITIES_RESPOND).toBe('capabilities:respond');
    expect(IPC_CHANNELS.AGENT_TYPES_REGISTRY_LIST).toBe('agent-types:registry-list');
    expect(IPC_CHANNELS.AGENT_MODEL_SELECTION_REGISTER).toBe(
      'agent-dispatch:model-selection-register'
    );
    expect(IPC_CHANNELS.AGENT_DISPATCH_BIND_SOURCE).toBe('agent-dispatch:bind-source');
    expect(IPC_CHANNELS.AGENT_DISPATCH).toBe('agent-dispatch:dispatch');
    expect(IPC_CHANNELS.AGENT_DISPATCH_EVENT).toBe('agent-dispatch:event');
    expect(IPC_CHANNELS.AGENT_SUMMON).toBe('agent-dispatch:summon');
    expect(IPC_CHANNELS.AGENT_COMPOSER_PREFILL).toBe('agent-dispatch:composer-prefill');
    expect(IPC_CHANNELS.SOURCE_AUTHORITY_READ).toBe('source-authority:read');
    expect(IPC_CHANNELS.SOURCE_AUTHORITY_CHANGED).toBe('source-authority:changed');
    expect(IPC_CHANNELS.SOURCE_PROJECT_CREATE).toBe('source-authority:project-create');
    expect(IPC_CHANNELS.SOURCE_CONVERSATION_CREATE).toBe('source-authority:conversation-create');
    expect(IPC_CHANNELS.SOURCE_CONVERSATION_UPDATE_SELECTION).toBe(
      'source-authority:conversation-update-selection'
    );
    expect(Object.keys(IPC_CHANNELS).some((key) => key.startsWith('BUILTIN_AGENTS_'))).toBe(false);
    expect(IPC_CHANNELS).not.toHaveProperty('CAPABILITIES_RESULT');
  });

  it('负测：漏 catalog 会被门禁抓住', () => {
    const catalog: Record<string, CapabilitySpec> = { ...CAPABILITY_CATALOG };
    delete catalog['general.language'];
    expect(
      auditCapabilityContract({
        inventory: PRODUCT_SURFACE_INVENTORY,
        catalog,
        handlerIds: new Set(Object.keys(CAPABILITY_HANDLER_CONTRACT)),
      })
    ).toContain('missing catalog: general.language');
  });

  it('负测：漏 executable handler 会被门禁抓住', () => {
    const handlerIds = new Set(Object.keys(CAPABILITY_HANDLER_CONTRACT));
    handlerIds.delete('providers.list');
    expect(
      auditCapabilityContract({
        inventory: PRODUCT_SURFACE_INVENTORY,
        catalog: CAPABILITY_CATALOG,
        handlerIds,
      })
    ).toContain('missing handler: providers.list');
  });

  it('负测：known-unavailable 空原因会被门禁抓住', () => {
    const catalog: Record<string, CapabilitySpec> = { ...CAPABILITY_CATALOG };
    const original = CAPABILITY_CATALOG['coding-tools.command'];
    if (original.execution.kind !== 'known-unavailable') throw new Error('invalid fixture');
    catalog['coding-tools.command'] = {
      ...original,
      execution: { ...original.execution, reason: '' },
    };
    expect(
      auditCapabilityContract({
        inventory: PRODUCT_SURFACE_INVENTORY,
        catalog,
        handlerIds: new Set(Object.keys(CAPABILITY_HANDLER_CONTRACT)),
      })
    ).toContain('empty unavailable reason: coding-tools.command');
  });

  it('负测：内部 lifecycle/debug id 混入 catalog 会被门禁抓住', () => {
    const catalog: Record<string, CapabilitySpec> = {
      ...CAPABILITY_CATALOG,
      'worker-exited': {
        ...CAPABILITY_CATALOG['general.language'],
        id: 'worker-exited',
      },
    };
    const issues = auditCapabilityContract({
      inventory: PRODUCT_SURFACE_INVENTORY,
      catalog,
      handlerIds: new Set(Object.keys(CAPABILITY_HANDLER_CONTRACT)),
    });
    expect(issues).toContain('catalog outside inventory: worker-exited');
    expect(issues).toContain('internal transport in catalog: worker-exited');
  });
});
