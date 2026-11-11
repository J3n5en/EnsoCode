import type { Api, Context, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { installStableToolOrder, stableToolOrder } from './toolOrder';

const tool = (name: string) => ({ name, description: name, parameters: {} }) as never;
const names = (context: Context) => (context.tools ?? []).map((t) => t.name);

describe('stableToolOrder', () => {
  it('同一工具集合无论注册先后都序列化成同一顺序', () => {
    const a = stableToolOrder({
      messages: [],
      tools: [tool('read'), tool('mcp__b'), tool('mcp__a')],
    });
    const b = stableToolOrder({
      messages: [],
      tools: [tool('mcp__a'), tool('read'), tool('mcp__b')],
    });
    expect(names(a)).toEqual(['mcp__a', 'mcp__b', 'read']);
    expect(names(b)).toEqual(names(a));
  });

  it('已有序或无工具时原样返回，不复制上下文', () => {
    const sorted: Context = { messages: [], tools: [tool('a'), tool('b')] };
    expect(stableToolOrder(sorted)).toBe(sorted);
    const bare: Context = { messages: [] };
    expect(stableToolOrder(bare)).toBe(bare);
  });

  it('不改动调用方的上下文', () => {
    const context: Context = { messages: [], tools: [tool('b'), tool('a')] };
    stableToolOrder(context);
    expect(names(context)).toEqual(['b', 'a']);
  });
});

describe('installStableToolOrder', () => {
  it('runtime 的两个出口都按名称排序后再下发', () => {
    const seen: string[][] = [];
    const method = vi.fn((_m: Model<Api>, context: Context) => {
      seen.push(names(context));
      return undefined as never;
    });
    const runtime = { stream: method, streamSimple: method } as unknown as ModelRuntime;
    installStableToolOrder(runtime);
    const target = runtime as unknown as Record<'stream' | 'streamSimple', typeof method>;
    const context: Context = { messages: [], tools: [tool('z'), tool('a')] };
    target.stream({} as Model<Api>, context);
    target.streamSimple({} as Model<Api>, context);
    expect(seen).toEqual([
      ['a', 'z'],
      ['a', 'z'],
    ]);
  });
});
