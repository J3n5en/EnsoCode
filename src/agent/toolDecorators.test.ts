import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { RunawayGuard } from './runawayGuard';
import { decorateSessionTools } from './toolDecorators';
import { ToolOutputBudget } from './toolOutputBudget';

describe('decorateSessionTools', () => {
  it('codemode 嵌套调用（<parent>/<n>）拿原始结果，不外置输出', async () => {
    const big = 'x'.repeat(200);
    const tool = {
      name: 'probe',
      label: 'probe',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({
        content: [{ type: 'text' as const, text: big }],
        details: undefined,
      }),
    } as unknown as ToolDefinition;
    const [decorated] = decorateSessionTools([tool], {
      runaway: new RunawayGuard(),
      budget: new ToolOutputBudget({
        rootDir: mkdtempSync(path.join(tmpdir(), 'enso-deco-')),
        maxInlineBytes: 50,
      }),
    });
    const nested = await decorated.execute('call_1/2', {}, undefined, undefined, {} as never);
    expect(nested.content).toEqual([{ type: 'text', text: big }]);
    const direct = await decorated.execute('call_1', {}, undefined, undefined, {} as never);
    expect(JSON.stringify(direct.content)).not.toContain(big);
  });

  it('codemode 禁用的工具标为 model-only：模型可直接调用，但不进脚本可调用集', () => {
    const make = (name: string) =>
      ({
        name,
        label: name,
        description: name,
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [], details: undefined }),
      }) as unknown as ToolDefinition;
    const [todo, read] = decorateSessionTools([make('todo'), make('read_file')], {
      runaway: new RunawayGuard(),
      budget: new ToolOutputBudget({ rootDir: mkdtempSync(path.join(tmpdir(), 'enso-deco-')) }),
    });
    expect(todo.exposure).toBe('model-only');
    expect(read.exposure).toBeUndefined();
  });
});
