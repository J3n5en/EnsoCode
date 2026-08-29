import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { CAPABILITY_CATALOG } from '@shared/capabilities/catalog';
import type { CapabilitySpec } from '@shared/capabilities/types';
import { PRODUCT_SURFACE_INVENTORY, type ProductSurfaceId } from '@shared/productSurfaces';

export interface EnsoCapabilityDescriptor {
  id: ProductSurfaceId;
  label: string;
  domain: string;
  description: string;
  inputSchema: CapabilitySpec['inputSchema'];
  resultSchema?: CapabilitySpec['resultSchema'];
  risk: CapabilitySpec['risk'];
  targetContext: CapabilitySpec['targetContext'];
  availability: CapabilitySpec['availability'];
  execution:
    | { kind: 'executable' }
    | {
        kind: 'known-unavailable';
        reason: string;
        suggestedAction: string;
      };
}

export interface EnsoCapabilitySummary {
  id: ProductSurfaceId;
  label: string;
  domain: string;
  risk: CapabilitySpec['risk'];
  targetContext: CapabilitySpec['targetContext'];
  availability: CapabilitySpec['availability'];
  execution:
    | { kind: 'executable' }
    | {
        kind: 'known-unavailable';
        reason: string;
      };
}

const isCapabilityId = (value: string): value is ProductSurfaceId =>
  Object.hasOwn(CAPABILITY_CATALOG, value);

/** 生成只含产品契约的 descriptor，不暴露 Gateway handler id 或内部传输细节。 */
export function describeEnsoCapability(capabilityId: string): EnsoCapabilityDescriptor | undefined {
  if (!isCapabilityId(capabilityId)) return undefined;
  const spec = CAPABILITY_CATALOG[capabilityId];
  return {
    id: spec.id,
    label: PRODUCT_SURFACE_INVENTORY[capabilityId].label,
    domain: spec.domain,
    description: spec.description,
    inputSchema: spec.inputSchema,
    ...(spec.resultSchema ? { resultSchema: spec.resultSchema } : {}),
    risk: spec.risk,
    targetContext: spec.targetContext,
    availability: spec.availability,
    execution:
      spec.execution.kind === 'executable'
        ? { kind: 'executable' }
        : {
            kind: 'known-unavailable',
            reason: spec.execution.reason,
            suggestedAction: spec.execution.suggestedAction,
          },
  };
}

/** Catalog 扩展后自动纳入；list 只给选路摘要，完整说明与 schema 留给 describe。 */
export function listEnsoCapabilities(): EnsoCapabilitySummary[] {
  return Object.keys(CAPABILITY_CATALOG)
    .sort()
    .flatMap((capabilityId) => {
      if (!isCapabilityId(capabilityId)) return [];
      const spec = CAPABILITY_CATALOG[capabilityId];
      return [
        {
          id: spec.id,
          label: PRODUCT_SURFACE_INVENTORY[capabilityId].label,
          domain: spec.domain,
          risk: spec.risk,
          targetContext: spec.targetContext,
          availability: spec.availability,
          execution:
            spec.execution.kind === 'executable'
              ? { kind: 'executable' as const }
              : { kind: 'known-unavailable' as const, reason: spec.execution.reason },
        },
      ];
    });
}

/** Enso 只读能力发现工具：list 全量，describe 精确查询。 */
export function createEnsoCapabilitiesTool(): ToolDefinition {
  return {
    name: 'enso_capabilities',
    label: 'Enso capabilities',
    description:
      'List compact EnsoCode capability summaries or describe one full public contract. Describe ' +
      'returns schemas and details without internal ids or secrets.',
    promptSnippet:
      'enso_capabilities: list when the catalog is not in context or the user asks about capabilities; ' +
      'describe before using an unclear capability with enso_app',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'describe'],
          description: 'list: all capabilities; describe: one capability contract',
        },
        capability_id: {
          type: 'string',
          description: 'Public capability id; required for describe',
        },
      },
      required: ['operation'],
      additionalProperties: false,
    } as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params) {
      const { operation, capability_id: capabilityId } = params as {
        operation?: string;
        capability_id?: string;
      };
      if (operation === 'list') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(listEnsoCapabilities()) }],
          details: undefined,
        };
      }
      if (operation !== 'describe') {
        throw new Error('operation must be "list" or "describe"');
      }
      if (!capabilityId?.trim()) throw new Error('describe requires capability_id');
      const descriptor = describeEnsoCapability(capabilityId.trim());
      if (!descriptor) throw new Error(`unknown capability: ${capabilityId.trim()}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(descriptor) }],
        details: undefined,
      };
    },
  };
}
