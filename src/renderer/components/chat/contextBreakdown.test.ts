import type { ContextOccupancy } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  compactionFreedPercent,
  contextBarSegments,
  contextItemLabel,
  contextItemTarget,
  contextPartItems,
} from './contextBreakdown';

const buckets = {
  system: 1000,
  instructions: 500,
  skills: 200,
  tools: 4000,
  conversation: 8000,
  compaction: 1000,
  projectMemory: 0,
  reminders: 100,
};

const occupancy = (over: Partial<ContextOccupancy> = {}): ContextOccupancy => ({
  buckets,
  used: 14800,
  estimated: true,
  compactedMessageCount: 0,
  compactionModelMismatch: false,
  contextWindow: 20000,
  ...over,
});

describe('contextBarSegments', () => {
  it('没有拆分时按八桶合并成五段，宽度按窗口算', () => {
    expect(contextBarSegments(occupancy())).toEqual([
      { kind: 'system', tokens: 1000, width: 5 },
      { kind: 'memory', tokens: 600, width: 3 },
      { kind: 'tools', tokens: 4000, width: 20 },
      { kind: 'skills', tokens: 200, width: 1 },
      { kind: 'chat', tokens: 9000, width: 45 },
    ]);
  });

  it('有拆分时按七类画，空类不出现', () => {
    const segments = contextBarSegments(
      occupancy({
        parts: [
          { kind: 'files', tokens: 3000, items: [{ name: 'a.ts', tag: 'read', tokens: 3000 }] },
          { kind: 'chat', tokens: 6000, items: [{ name: '1', tag: 'turn', tokens: 6000 }] },
        ],
      })
    );
    expect(segments.map((segment) => segment.kind)).toEqual(['files', 'chat']);
  });

  it('没有窗口时按已用量算宽度', () => {
    const [first] = contextBarSegments(occupancy({ contextWindow: undefined }));
    expect(first).toMatchObject({ kind: 'system', width: 6.8 });
  });
});

describe('contextPartItems', () => {
  it('保留 worker 给的顺序，合并项留在末尾', () => {
    const items = [
      { name: 'summary', tag: 'compacted', tokens: 900 },
      { name: 'earlier', tag: 'turns', n: 4, tokens: 300 },
      { name: '5', tag: 'turn', tokens: 50 },
      { name: '6', tag: 'turn', tokens: 800 },
    ];
    expect(
      contextPartItems([{ kind: 'chat', tokens: 2050, items }], 'chat').map((it) => it.name)
    ).toEqual(['summary', 'earlier', '5', '6']);
    expect(contextPartItems(undefined, 'tools')).toEqual([]);
  });

  it('超过上限时普通类把尾部并入「其余」，已有的合并项计数累加', () => {
    const items = [
      ...Array.from({ length: 9 }, (_, i) => ({ name: `t${i}`, tag: '', tokens: 100 - i })),
      { name: 'other', tag: 'more', n: 20, tokens: 500 },
    ];
    const shown = contextPartItems([{ kind: 'tools', tokens: 1364, items }], 'tools');
    expect(shown).toHaveLength(8);
    expect(shown.slice(0, 7).map((it) => it.name)).toEqual([
      't0',
      't1',
      't2',
      't3',
      't4',
      't5',
      't6',
    ]);
    expect(shown[7]).toEqual({ name: 'other', tag: 'more', n: 22, tokens: 93 + 92 + 500 });
  });

  it('超过上限时对话类保留摘要和最近几轮，把最早的轮次并入「更早」', () => {
    const items = [
      { name: 'summary', tag: 'compacted', tokens: 1000 },
      { name: 'earlier', tag: 'turns', n: 5, tokens: 300 },
      ...Array.from({ length: 9 }, (_, i) => ({ name: String(i + 6), tag: 'turn', tokens: 10 })),
    ];
    const shown = contextPartItems([{ kind: 'chat', tokens: 1390, items }], 'chat');
    expect(shown).toHaveLength(8);
    expect(shown[0].name).toBe('summary');
    expect(shown[1]).toEqual({ name: 'earlier', tag: 'turns', n: 8, tokens: 330 });
    expect(shown.slice(2).map((it) => it.name)).toEqual(['9', '10', '11', '12', '13', '14']);
  });
});

describe('contextItemLabel', () => {
  it('合并项、轮次、摘要、提醒翻成可读文字，其余原样', () => {
    expect(contextItemLabel({ name: 'other', tag: 'more', n: 3, tokens: 1 })).toEqual({
      key: '{{count}} more',
      vars: { count: 3 },
    });
    expect(contextItemLabel({ name: 'earlier', tag: 'turns', n: 4, tokens: 1 })).toEqual({
      key: 'Earlier {{count}} turns',
      vars: { count: 4 },
    });
    expect(contextItemLabel({ name: '7', tag: 'turn', tokens: 1 })).toEqual({
      key: 'Turn {{count}}',
      vars: { count: '7' },
    });
    expect(contextItemLabel({ name: 'summary', tag: 'compacted', tokens: 1 })).toEqual({
      key: 'Compacted summary',
    });
    expect(contextItemLabel({ name: 'reminders', tag: 'reminder', tokens: 1 })).toEqual({
      key: 'System reminders',
    });
    expect(contextItemLabel({ name: 'src/a.ts', tag: 'read', tokens: 1 })).toEqual({
      raw: 'src/a.ts',
    });
  });
});

describe('compactionFreedPercent', () => {
  it('压缩前后都已知且确实变小才给百分比', () => {
    expect(compactionFreedPercent(142_000, 21_000)).toBe(85);
    expect(compactionFreedPercent(null, 21_000)).toBeNull();
    expect(compactionFreedPercent(142_000, undefined)).toBeNull();
    expect(compactionFreedPercent(10_000, 12_000)).toBeNull();
    expect(compactionFreedPercent(0, 0)).toBeNull();
  });
});

describe('contextItemTarget', () => {
  const item = (name: string, tag: string) => ({ name, tag, tokens: 1 });
  it('读入的文件在工作区内可打开，工作区外不给入口', () => {
    expect(contextItemTarget('files', item('/repo/src/a.ts', 'read'), '/repo')).toEqual({
      type: 'file',
      rel: 'src/a.ts',
    });
    expect(contextItemTarget('files', item('src/b.ts', 'shell'), '/repo')).toEqual({
      type: 'file',
      rel: 'src/b.ts',
    });
    expect(contextItemTarget('files', item('/etc/hosts', 'read'), '/repo')).toBeNull();
    expect(contextItemTarget('files', item('image', 'image'), '/repo')).toBeNull();
  });

  it('工具、MCP、Skill 跳到对应设置页；指令文件在工作区内打开，否则跳设置', () => {
    expect(contextItemTarget('tools', item('mcp__github', 'mcp'), '/repo')).toEqual({
      type: 'settings',
      link: { category: 'mcp', rowId: 'mcp.root' },
    });
    expect(contextItemTarget('tools', item('bash', ''), '/repo')).toEqual({
      type: 'settings',
      link: { category: 'tools', rowId: 'tools.root' },
    });
    expect(contextItemTarget('skills', item('deploy', 'skills'), '/repo')).toEqual({
      type: 'settings',
      link: { category: 'skills', rowId: 'skills.root' },
    });
    expect(contextItemTarget('memory', item('/repo/AGENTS.md', 'project'), '/repo')).toEqual({
      type: 'file',
      rel: 'AGENTS.md',
    });
    expect(contextItemTarget('memory', item('/home/u/AGENTS.md', 'project'), '/repo')).toEqual({
      type: 'settings',
      link: { category: 'instructions', rowId: 'instructions.root' },
    });
  });

  it('合并项、系统提示、对话轮次、工具输出没有入口', () => {
    expect(contextItemTarget('tools', item('other', 'more'), '/repo')).toBeNull();
    expect(contextItemTarget('system', item('system', ''), '/repo')).toBeNull();
    expect(contextItemTarget('chat', item('3', 'turn'), '/repo')).toBeNull();
    expect(contextItemTarget('results', item('bash', 'result'), '/repo')).toBeNull();
    expect(contextItemTarget('memory', item('reminders', 'reminder'), '/repo')).toBeNull();
  });
});
