import { describe, expect, it } from 'vitest';
import { buildContextParts, filesOfCommand } from './contextParts';

const zero = {
  system: 0,
  instructions: 0,
  skills: 0,
  tools: 0,
  conversation: 0,
  compaction: 0,
  reminders: 0,
};
const textLen = (message: unknown): number => {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum: number, part: { type?: string; text?: string }) => {
    if (part.type === 'image') return sum + 100;
    return sum + (part.text?.length ?? 0);
  }, 0);
};
const base = {
  agentsFiles: [],
  skills: [],
  tools: [],
  reminders: [],
  messages: [],
  estimate: textLen,
};
const part = (parts: ReturnType<typeof buildContextParts>['parts'], kind: string) =>
  parts.find((p) => p.kind === kind);

describe('filesOfCommand', () => {
  it('只认纯读文件的命令', () => {
    expect(filesOfCommand('cat a.ts b.ts')).toEqual(['a.ts', 'b.ts']);
    expect(filesOfCommand('head -n 40 src/x.ts')).toEqual(['src/x.ts']);
    expect(filesOfCommand("sed -n 1,80p 'src/y.ts'")).toEqual(['src/y.ts']);
    expect(filesOfCommand('cd repo && cat z.md')).toEqual(['z.md']);
    expect(filesOfCommand('cat a | grep x')).toEqual([]);
    expect(filesOfCommand('ls -la')).toEqual([]);
  });
});

describe('buildContextParts', () => {
  it('按 magpie 七类拆分，条目合计等于分类合计', () => {
    const { parts, turns } = buildContextParts({
      ...base,
      buckets: {
        ...zero,
        system: 50,
        instructions: 30,
        skills: 20,
        tools: 40,
        conversation: 400,
        reminders: 10,
      },
      agentsFiles: [
        { path: '/p/AGENTS.md', content: 'x'.repeat(80) },
        { path: '/home/CLAUDE.md', content: 'x'.repeat(40) },
      ],
      skills: [{ name: 'diffs', description: 'd' }],
      tools: [
        { name: 'read', description: 'r' },
        { name: 'mcp__github__issues', description: 'a' },
        { name: 'mcp__github__prs', description: 'b' },
      ],
      reminders: ['todo'],
      messages: [
        { role: 'user', content: 'u'.repeat(20) },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'a'.repeat(20) },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'src/a.ts' } },
            { type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'cat b.ts c.ts' } },
            { type: 'toolCall', id: 'c3', name: 'grep', arguments: { pattern: 'x' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'read',
          content: [{ type: 'text', text: 'f'.repeat(100) }],
        },
        {
          role: 'toolResult',
          toolCallId: 'c2',
          toolName: 'bash',
          content: [{ type: 'text', text: 'g'.repeat(60) }],
        },
        {
          role: 'toolResult',
          toolCallId: 'c3',
          toolName: 'grep',
          content: [
            { type: 'text', text: 'h'.repeat(40) },
            { type: 'image', data: '', mimeType: 'image/png' },
          ],
        },
        { role: 'user', content: 'v'.repeat(60) },
      ],
    });
    expect(parts.map((p) => p.kind)).toEqual([
      'system',
      'tools',
      'skills',
      'memory',
      'files',
      'results',
      'chat',
    ]);
    for (const p of parts) {
      expect(p.items.reduce((s, it) => s + it.tokens, 0)).toBe(p.tokens);
    }
    expect(part(parts, 'system')?.tokens).toBe(50);
    expect(part(parts, 'tools')?.tokens).toBe(40);
    expect(part(parts, 'tools')?.items.find((it) => it.tag === 'mcp')).toMatchObject({
      name: 'mcp__github',
      n: 2,
    });
    expect(part(parts, 'memory')?.tokens).toBe(40);
    expect(part(parts, 'memory')?.items.map((it) => it.name)).toEqual([
      '/p/AGENTS.md',
      '/home/CLAUDE.md',
      'reminders',
    ]);
    const files = part(parts, 'files');
    expect(files?.items.map((it) => [it.name, it.tag])).toEqual([
      ['image', 'image'],
      ['src/a.ts', 'read'],
      ['b.ts', 'shell'],
      ['c.ts', 'shell'],
    ]);
    expect(part(parts, 'results')?.items).toEqual([
      { name: 'grep', tag: 'result', tokens: expect.any(Number) },
    ]);
    expect(part(parts, 'chat')?.items.map((it) => it.name)).toEqual(['1', '2']);
    const conversation = ['files', 'results', 'chat'].reduce(
      (sum, kind) => sum + (part(parts, kind)?.tokens ?? 0),
      0
    );
    expect(conversation).toBe(400);
    expect(turns).toBe(2);
  });

  it('压缩摘要算会话里最早的一项，空分类不出现', () => {
    const { parts } = buildContextParts({
      ...base,
      buckets: { ...zero, compaction: 30, conversation: 10 },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(parts.map((p) => p.kind)).toEqual(['chat']);
    expect(part(parts, 'chat')?.items).toEqual([
      { name: 'summary', tag: 'compacted', tokens: 30 },
      { name: '1', tag: 'turn', tokens: 10 },
    ]);
  });

  it('每类最多 24 项：会话保留最近的，其余按大小合并', () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: 'user',
      content: 'x'.repeat(i + 1),
    }));
    const tools = Array.from({ length: 30 }, (_, i) => ({
      name: `t${i}`,
      description: 'd'.repeat(i * 10),
    }));
    const { parts } = buildContextParts({
      ...base,
      buckets: { ...zero, tools: 1000, conversation: 465 },
      tools,
      messages,
    });
    const chat = part(parts, 'chat')?.items ?? [];
    expect(chat).toHaveLength(24);
    expect(chat[0]).toMatchObject({ name: 'earlier', tag: 'turns', n: 7 });
    expect(chat.at(-1)?.name).toBe('30');
    const toolItems = part(parts, 'tools')?.items ?? [];
    expect(toolItems).toHaveLength(24);
    expect(toolItems.at(-1)).toMatchObject({ name: 'other', tag: 'more', n: 7 });
    expect(toolItems[0].name).toBe('t29');
  });
});
