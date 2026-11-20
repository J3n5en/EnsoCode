import { describe, expect, it } from 'vitest';
import { buildTimeline, foldTimeline, type TimelineItem } from './timeline';

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

const png = { type: 'image' as const, data: 'iVBORw0KGgo=', mimeType: 'image/png' };
const facts = JSON.stringify({
  path: '/tmp/shot.png',
  size: 8,
  width: 2,
  height: 1,
  mimeType: 'image/png',
});

const CALLS = {
  b: { id: 'b', name: 'bash', arguments: { command: 'ls' } },
  m: { id: 'm', name: 'mcp__srv__lookup', arguments: { q: 'x' } },
  w: { id: 'w', name: 'image_view', arguments: { path: '/Users/me/x.png' } },
  v: { id: 'v', name: 'image_view', arguments: { path: '/tmp/shot.png' } },
};

function turn(secretarySession: boolean, order: (keyof typeof CALLS)[]) {
  const calls = order.map((id) => CALLS[id]);
  const results: Record<string, { content: unknown[]; isError?: boolean }> = {
    b: { content: [{ type: 'text', text: 'a.txt' }] },
    m: { content: [{ type: 'text', text: 'ok' }] },
    v: { content: [{ type: 'text', text: facts }, png] },
    w: { content: [{ type: 'text', text: 'path is out of scope' }], isError: true },
  };
  return buildTimeline(
    [
      { role: 'user', content: [{ type: 'text', text: 'look' }] },
      ...calls.flatMap((call) => [
        { role: 'assistant' as const, content: [{ type: 'toolCall' as const, ...call }] },
        {
          role: 'toolResult' as const,
          toolCallId: call.id,
          toolName: call.name,
          ...results[call.id],
        },
      ]),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ] as Parameters<typeof buildTimeline>[0],
    false,
    [],
    '/tmp',
    { secretarySession }
  );
}

const tools = (items: TimelineItem[]) =>
  items.filter((item): item is ToolItem => item.kind === 'tool');

describe('image_view 的图片进时间线', () => {
  it('成功结果带上原图片块引用，失败结果没有图片', () => {
    const [, , refused, ok] = tools(turn(false, ['b', 'm', 'w', 'v']));
    expect(ok).toMatchObject({ name: 'image_view', state: 'ok' });
    expect(ok?.image).toMatchObject({ data: png.data, mimeType: png.mimeType });
    expect(refused).toMatchObject({ state: 'error', output: 'path is out of scope' });
    expect(refused?.image).toBeUndefined();
  });

  it('普通会话：bash、MCP、image_view 都是工具行，完成后归进同一个「已工作」组', () => {
    const items = turn(false, ['b', 'v', 'm', 'w']);
    for (const item of tools(items)) expect(item.args).toBeUndefined();
    const folded = foldTimeline(items, false, new Set(), { collapseCompletedActivity: true });
    const groups = folded.filter(
      (item): item is Extract<TimelineItem, { kind: 'tool-group' }> => item.kind === 'tool-group'
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.activity).toBeDefined();
    expect(groups[0]?.count).toBe(3);
    expect(tools(groups[0]?.children ?? []).map((item) => item.name)).toEqual([
      'bash',
      'image_view',
      'mcp__srv__lookup',
    ]);
    // 失败的那次照旧留在组外，按工具行显示错误
    expect(tools(folded)).toMatchObject([{ name: 'image_view', state: 'error' }]);
    expect(tools(items).every((item) => item.cardPeers === undefined)).toBe(true);
  });

  it('普通会话默认折叠：四个调用进同一个工具组', () => {
    const folded = foldTimeline(turn(false, ['b', 'm', 'v', 'w']), false, new Set());
    const group = folded.find(
      (item): item is Extract<TimelineItem, { kind: 'tool-group' }> => item.kind === 'tool-group'
    );
    expect(group?.count).toBe(4);
    expect(folded.some((item) => item.kind === 'tool')).toBe(false);
  });

  it('秘书会话：连续 image_view 并成一张卡片，后续几次的图片也跟着', () => {
    const folded = foldTimeline(turn(true, ['b', 'm', 'w', 'v']), false, new Set(), {
      readableToolCards: true,
    });
    const card = tools(folded).find((item) => item.name === 'image_view');
    expect(card).toMatchObject({ state: 'error' });
    expect(card?.image).toBeUndefined();
    expect(card?.cardPeers).toHaveLength(1);
    expect(card?.cardPeers?.[0]).toMatchObject({ state: 'ok' });
    expect(card?.cardPeers?.[0]?.image?.data).toBe(png.data);
  });
});
