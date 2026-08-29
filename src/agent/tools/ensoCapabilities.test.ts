import { CAPABILITY_CATALOG } from '@shared/capabilities/catalog';
import { describe, expect, it } from 'vitest';
import {
  createEnsoCapabilitiesTool,
  describeEnsoCapability,
  listEnsoCapabilities,
} from './ensoCapabilities';

describe('enso_capabilities', () => {
  it('list 稳定覆盖 catalog，只返回 compact summary 且不暴露 schema/handler', () => {
    const summaries = listEnsoCapabilities();
    const ids = summaries.map((summary) => summary.id);

    expect(ids).toEqual([...Object.keys(CAPABILITY_CATALOG)].sort());
    expect(JSON.stringify(summaries)).not.toContain('handlerId');
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty('description');
      expect(summary).not.toHaveProperty('inputSchema');
      expect(summary).not.toHaveProperty('resultSchema');
    }
    expect(summaries.find((summary) => summary.id === 'providers.list')?.execution).toEqual({
      kind: 'executable',
    });
    expect(summaries.find((summary) => summary.id === 'coding-tools.command')?.execution).toEqual({
      kind: 'known-unavailable',
      reason: expect.any(String),
    });
  });

  it('describe 为 known-unavailable 返回原因、建议动作与 availability', () => {
    const descriptor = describeEnsoCapability('coding-tools.command');

    expect(descriptor).toMatchObject({
      id: 'coding-tools.command',
      execution: {
        kind: 'known-unavailable',
        reason: expect.any(String),
        suggestedAction: expect.any(String),
      },
      availability: expect.any(Array),
      description: expect.any(String),
      inputSchema: expect.any(Object),
    });
    expect(descriptor).not.toHaveProperty('execution.handlerId');
  });

  it('describe 拒绝未知 capability，list/describe 只返回公开 JSON', async () => {
    const tool = createEnsoCapabilitiesTool();
    const context = {} as Parameters<typeof tool.execute>[4];
    const listResult = await tool.execute(
      'call-list',
      { operation: 'list' },
      undefined,
      undefined,
      context
    );
    const firstContent = listResult.content[0];
    if (firstContent?.type !== 'text') throw new Error('expected text tool result');
    expect(JSON.parse(firstContent.text)).toHaveLength(Object.keys(CAPABILITY_CATALOG).length);

    await expect(
      tool.execute(
        'call-unknown',
        { operation: 'describe', capability_id: 'raw.ipc.invoke' },
        undefined,
        undefined,
        context
      )
    ).rejects.toThrow('unknown capability: raw.ipc.invoke');
  });
});
