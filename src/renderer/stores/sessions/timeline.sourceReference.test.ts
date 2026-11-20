import { describe, expect, it } from 'vitest';
import { buildTimeline, type TimelineItem } from './timeline';

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

function outputOf(name: string, args: unknown, content: unknown[], isError = false) {
  const items = buildTimeline(
    [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 't', name, arguments: args }] },
      { role: 'toolResult', toolCallId: 't', toolName: name, content, isError },
    ] as Parameters<typeof buildTimeline>[0],
    false,
    [],
    '/tmp'
  );
  return items.find((item): item is ToolItem => item.kind === 'tool')?.output;
}

const fileRef = '<source_reference type="file" path="/tmp/nope.png" />';
const webRef = '<source_reference type="web" url="https://example.com/a?b=1&amp;c" />';

describe('工具详情不显示 withSourceReference 追加的标记', () => {
  it('image_view 失败：只剩工具的错误文字', () => {
    const text = `no such file: /tmp/nope.png\n${fileRef}`;
    expect(outputOf('image_view', { path: '/tmp/nope.png' }, [{ type: 'text', text }], true)).toBe(
      'no such file: /tmp/nope.png'
    );
  });

  it('read / web_fetch 等其他工具也剥掉末尾标记，多条一起剥', () => {
    expect(
      outputOf('read', { path: 'a.ts' }, [{ type: 'text', text: `body\n${fileRef}\n${webRef}` }])
    ).toBe('body');
    expect(
      outputOf('web_fetch', { url: 'https://example.com' }, [
        { type: 'text', text: `# Hi\n${webRef}` },
      ])
    ).toBe('# Hi');
  });

  it('结果没有文字时追加的那段纯标记不显示', () => {
    expect(outputOf('write', { path: 'a.ts' }, [{ type: 'text', text: fileRef }])).toBe('');
  });

  it('正文中间恰好出现的同样文字原样保留', () => {
    const text = `${fileRef}\nreal content`;
    expect(outputOf('read', { path: 'a.ts' }, [{ type: 'text', text }])).toBe(text);
  });
});
