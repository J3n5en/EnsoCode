import { describe, expect, it } from 'vitest';
import {
  CONTEXT_OCCUPANCY_BUCKETS,
  charsToTokens,
  collectContextOccupancy,
  summarizeContextOccupancy,
} from './contextOccupancy';

const emptyBuckets = () =>
  Object.fromEntries(CONTEXT_OCCUPANCY_BUCKETS.map((id) => [id, 0])) as Record<
    (typeof CONTEXT_OCCUPANCY_BUCKETS)[number],
    number
  >;

describe('summarizeContextOccupancy', () => {
  it('字符按 /4 估算，向上取整', () => {
    expect(charsToTokens(0)).toBe(0);
    expect(charsToTokens(1)).toBe(1);
    expect(charsToTokens(4)).toBe(1);
    expect(charsToTokens(5)).toBe(2);
  });

  it('缺文件与空记忆记 0，不把面板打空', () => {
    const occupancy = summarizeContextOccupancy({
      systemText: 'sys',
      instructionText: '',
      skillTexts: [],
      toolDefinitionTexts: [],
      conversationTokens: 12,
      compactionTokens: 0,
      compactedMessageCount: 0,
      projectMemoryText: '',
      projectMemoryEnabled: true,
      reminderText: '',
      currentModelFamily: 'claude',
      compactionModelFamily: undefined,
    });
    expect(occupancy.buckets.instructions).toBe(0);
    expect(occupancy.buckets.skills).toBe(0);
    expect(occupancy.buckets.projectMemory).toBe(0);
    expect(occupancy.buckets.conversation).toBe(12);
    expect(occupancy.estimated).toBe(true);
    expect(occupancy.compactedMessageCount).toBe(0);
    expect(occupancy.compactionModelMismatch).toBe(false);
  });

  it('指令 + skill + 压缩都非零，各桶之和等于 used', () => {
    const occupancy = summarizeContextOccupancy({
      systemText: 'abcd',
      instructionText: 'abcdefgh',
      skillTexts: ['abcd'],
      toolDefinitionTexts: ['abcd'],
      conversationTokens: 20,
      compactionTokens: 8,
      compactedMessageCount: 6,
      projectMemoryText: '',
      projectMemoryEnabled: true,
      reminderText: 'abcd',
      currentModelFamily: 'claude',
      compactionModelFamily: 'claude',
    });
    expect(occupancy.buckets.system).toBe(1);
    expect(occupancy.buckets.instructions).toBe(2);
    expect(occupancy.buckets.skills).toBe(1);
    expect(occupancy.buckets.tools).toBe(1);
    expect(occupancy.buckets.conversation).toBe(20);
    expect(occupancy.buckets.compaction).toBe(8);
    expect(occupancy.buckets.projectMemory).toBe(0);
    expect(occupancy.buckets.reminders).toBe(1);
    expect(occupancy.used).toBe(34);
    expect(occupancy.compactedMessageCount).toBe(6);
    expect(occupancy.compactionModelMismatch).toBe(false);
  });

  it('关 project_memory 或空文件该桶恒 0', () => {
    const withText = summarizeContextOccupancy({
      systemText: '',
      instructionText: '',
      skillTexts: [],
      toolDefinitionTexts: [],
      conversationTokens: 0,
      compactionTokens: 0,
      compactedMessageCount: 0,
      projectMemoryText: 'remember this',
      projectMemoryEnabled: false,
      reminderText: '',
      currentModelFamily: 'gpt',
    });
    expect(withText.buckets.projectMemory).toBe(0);
  });

  it('压缩模型家族与当前不一致则标 mismatch', () => {
    const occupancy = summarizeContextOccupancy({
      systemText: '',
      instructionText: '',
      skillTexts: [],
      toolDefinitionTexts: [],
      conversationTokens: 1,
      compactionTokens: 1,
      compactedMessageCount: 3,
      projectMemoryText: '',
      projectMemoryEnabled: true,
      reminderText: '',
      currentModelFamily: 'claude',
      compactionModelFamily: 'gpt',
    });
    expect(occupancy.compactionModelMismatch).toBe(true);
  });

  it('窗口未知不编造百分比', () => {
    const occupancy = summarizeContextOccupancy({
      ...{
        systemText: 'abcd',
        instructionText: '',
        skillTexts: [],
        toolDefinitionTexts: [],
        conversationTokens: 4,
        compactionTokens: 0,
        compactedMessageCount: 0,
        projectMemoryText: '',
        projectMemoryEnabled: true,
        reminderText: '',
        currentModelFamily: 'claude',
      },
      contextWindow: undefined,
    });
    expect(occupancy.contextWindow).toBeUndefined();
    expect(occupancy.percent).toBeUndefined();
    expect(occupancy.used).toBeGreaterThan(0);
  });

  it('窗口已知才给百分比，且不超过 100', () => {
    const occupancy = summarizeContextOccupancy({
      systemText: 'x'.repeat(400),
      instructionText: '',
      skillTexts: [],
      toolDefinitionTexts: [],
      conversationTokens: 50,
      compactionTokens: 0,
      compactedMessageCount: 0,
      projectMemoryText: '',
      projectMemoryEnabled: true,
      reminderText: '',
      currentModelFamily: 'claude',
      contextWindow: 10,
    });
    expect(occupancy.percent).toBe(100);
    expect(occupancy.contextWindow).toBe(10);
  });

  it('桶集合固定为 8 个，含预留项目记忆', () => {
    expect([...CONTEXT_OCCUPANCY_BUCKETS]).toEqual([
      'system',
      'instructions',
      'skills',
      'tools',
      'conversation',
      'compaction',
      'projectMemory',
      'reminders',
    ]);
    const occupancy = summarizeContextOccupancy({
      systemText: '',
      instructionText: '',
      skillTexts: [],
      toolDefinitionTexts: [],
      conversationTokens: 0,
      compactionTokens: 0,
      compactedMessageCount: 0,
      projectMemoryText: '',
      projectMemoryEnabled: true,
      reminderText: '',
      currentModelFamily: 'claude',
    });
    expect(occupancy.buckets).toEqual(emptyBuckets());
  });
});

describe('summarizeContextOccupancy 的 usedOverride / anchored', () => {
  const baseInput = {
    systemText: 'abcd',
    instructionText: 'abcd',
    skillTexts: [],
    toolDefinitionTexts: [],
    conversationTokens: 10,
    compactionTokens: 0,
    compactedMessageCount: 0,
    projectMemoryText: '',
    projectMemoryEnabled: true,
    reminderText: '',
    currentModelFamily: 'claude',
  };

  it('提供 usedOverride 时 used 直接采用该值，而非桶之和', () => {
    const occupancy = summarizeContextOccupancy({
      ...baseInput,
      usedOverride: 999,
      anchored: true,
    } as Parameters<typeof summarizeContextOccupancy>[0]);
    expect(occupancy.used).toBe(999);
  });

  it('提供 usedOverride 时会话桶回填为 usedOverride 减去其余桶之和', () => {
    // system=1, instructions=1，其余桶为 0，usedOverride=500
    const occupancy = summarizeContextOccupancy({
      ...baseInput,
      usedOverride: 500,
      anchored: true,
    } as Parameters<typeof summarizeContextOccupancy>[0]);
    const otherBuckets = occupancy.buckets.system + occupancy.buckets.instructions;
    expect(occupancy.buckets.conversation).toBe(Math.max(0, 500 - otherBuckets));
  });

  it('anchored 为 true 时 estimated 为 false', () => {
    const occupancy = summarizeContextOccupancy({
      ...baseInput,
      usedOverride: 500,
      anchored: true,
    } as Parameters<typeof summarizeContextOccupancy>[0]);
    expect(occupancy.estimated).toBe(false);
  });

  it('anchored 为 false（或缺省）时 estimated 仍为 true', () => {
    const withFalse = summarizeContextOccupancy({
      ...baseInput,
      usedOverride: 500,
      anchored: false,
    } as Parameters<typeof summarizeContextOccupancy>[0]);
    expect(withFalse.estimated).toBe(true);

    const withoutFlag = summarizeContextOccupancy(baseInput);
    expect(withoutFlag.estimated).toBe(true);
    expect(withoutFlag.used).toBe(
      withoutFlag.buckets.system +
        withoutFlag.buckets.instructions +
        withoutFlag.buckets.skills +
        withoutFlag.buckets.tools +
        withoutFlag.buckets.conversation +
        withoutFlag.buckets.compaction +
        withoutFlag.buckets.projectMemory +
        withoutFlag.buckets.reminders
    );
  });
});

describe('collectContextOccupancy', () => {
  it('对话走 estimateTokens；压缩摘要单独成桶；折叠条数按 firstKept 之前计', () => {
    const occupancy = collectContextOccupancy({
      systemPrompt: 'abcd',
      agentsFiles: [{ path: '/p/AGENTS.md', content: 'abcdefgh' }],
      skills: [{ name: 'deploy', description: 'abcd' }],
      tools: [{ name: 'bash', description: 'ab', parameters: {} }],
      contextMessages: [
        { role: 'user', content: 'xxxx', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: 'yyyy' }], timestamp: 2 },
      ],
      branch: [
        { type: 'message', id: 'm1', parentId: null, timestamp: 't' },
        { type: 'message', id: 'm2', parentId: 'm1', timestamp: 't' },
        {
          type: 'compaction',
          id: 'c1',
          parentId: 'm2',
          timestamp: 't',
          summary: 'xxxxxxxx',
          firstKeptEntryId: 'k1',
          tokensBefore: 99,
        },
        { type: 'message', id: 'k1', parentId: 'c1', timestamp: 't' },
      ],
      compactionModelFamily: 'gpt',
      currentModelFamily: 'claude',
      contextWindow: 200,
      pendingTaskReminders: ['abcd'],
    });
    expect(occupancy.buckets.system).toBe(1);
    expect(occupancy.buckets.instructions).toBe(2);
    expect(occupancy.buckets.skills).toBeGreaterThan(0);
    expect(occupancy.buckets.tools).toBeGreaterThan(0);
    expect(occupancy.buckets.conversation).toBeGreaterThan(0);
    expect(occupancy.buckets.compaction).toBe(2);
    expect(occupancy.compactedMessageCount).toBe(2);
    expect(occupancy.compactionModelMismatch).toBe(true);
    expect(occupancy.buckets.projectMemory).toBe(0);
    expect(occupancy.buckets.reminders).toBe(1);
  });
});
