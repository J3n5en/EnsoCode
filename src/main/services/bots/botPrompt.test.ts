import { describe, expect, it } from 'vitest';
import {
  BOT_READONLY_DISABLED_TOOLS,
  buildBotModeInstruction,
  buildBotSystemPrompt,
  mergeBotInstruction,
  pickBotModel,
} from './botPrompt';

const alice = { id: 'a', name: 'Alice', title: 'Backend', scope: 'APIs and databases' };
const bob = { id: 'b', name: 'Bob', title: '', scope: '' };

describe('buildBotSystemPrompt', () => {
  it('把名字、头衔、职责放在人设正文之前', () => {
    const prompt = buildBotSystemPrompt(alice, '  Speaks tersely.\n');
    expect(prompt.startsWith('You are Alice (Backend).')).toBe(true);
    expect(prompt).toContain('Your responsibility: APIs and databases');
    expect(prompt.endsWith('Speaks tersely.')).toBe(true);
  });

  it('头衔、职责、人设缺省时不留空行', () => {
    expect(buildBotSystemPrompt(bob, '')).toBe('You are Bob.');
  });
});

describe('buildBotModeInstruction', () => {
  it('私聊：聊天式简洁、最终正文即消息，不提 [skip] 和名册', () => {
    const text = buildBotModeInstruction({ self: alice, kind: 'direct', roster: [] });
    expect(text).toContain('Bot mode');
    expect(text).toMatch(/final reply/i);
    expect(text).not.toContain('[skip]');
    expect(text).not.toContain('Group members');
    expect(text).not.toContain('group_tasks');
    expect(text).not.toContain('group_history');
  });

  it('群聊：说明任务看板（拆分多步工作、先认领、完成写结果、别刷屏）与群记忆归属', () => {
    const text = buildBotModeInstruction({ self: alice, kind: 'group', roster: [alice, bob] });
    expect(text).toContain('group_tasks');
    expect(text).toMatch(/claim/i);
    expect(text).toMatch(/result/i);
    expect(text).toMatch(/do not create a task for every/i);
    expect(text).toMatch(/taskId/);
    expect(text).toContain("spaceId 'chat'");
  });

  it('群聊：说明压缩后或需核对原话时用 group_history 回查', () => {
    const text = buildBotModeInstruction({ self: alice, kind: 'group', roster: [alice, bob] });
    expect(text).toContain('group_history');
    expect(text).toMatch(/compacted/i);
  });

  it('群聊：说明 [skip] 并列出名册（标出自己）', () => {
    const text = buildBotModeInstruction({ self: alice, kind: 'group', roster: [alice, bob] });
    expect(text).toContain('[skip]');
    expect(text).toContain('- Alice (Backend) — APIs and databases (you)');
    expect(text).toContain('- Bob');
  });

  it('群聊：被选中但无需发言时回复 [skip]，被人类直接 @ 时应尽量回复', () => {
    const text = buildBotModeInstruction({ self: alice, kind: 'group', roster: [alice, bob] });
    expect(text).toMatch(/already (been )?answered/i);
    expect(text).toMatch(/outside your responsibility/i);
    expect(text).toMatch(/human @mentions you directly.*reply/i);
  });
});

describe('mergeBotInstruction', () => {
  it('有全局指令时追加在其后并沿用其路径', () => {
    expect(mergeBotInstruction({ path: '/g.md', content: 'G' }, 'B', '/bot.md')).toEqual({
      path: '/g.md',
      content: 'G\n\nB',
    });
    expect(mergeBotInstruction(undefined, 'B', '/bot.md')).toEqual({
      path: '/bot.md',
      content: 'B',
    });
  });
});

describe('pickBotModel', () => {
  const usable = new Set(['p/m1', 'p/def']);
  const isUsable = (ref: { providerId: string; modelId: string }) =>
    usable.has(`${ref.providerId}/${ref.modelId}`);
  const settings = { defaultModel: { providerId: 'p', modelId: 'def' } };

  it('成员引擎可用时用它和它的思考档', () => {
    expect(
      pickBotModel({ providerId: 'p', modelId: 'm1', thinkingLevel: 'high' }, settings, isUsable)
    ).toEqual({ providerId: 'p', modelId: 'm1', reasoningEnabled: true, thinkingLevel: 'high' });
  });

  it('引擎缺省或不可用时回落全局默认模型与默认推理档', () => {
    const fallback = {
      providerId: 'p',
      modelId: 'def',
      reasoningEnabled: false,
      thinkingLevel: 'low',
    };
    const state = { ...settings, defaultReasoningEnabled: false, defaultThinkingLevel: 'low' };
    expect(pickBotModel(undefined, state, isUsable)).toEqual(fallback);
    expect(pickBotModel({ providerId: 'x', modelId: 'gone' }, state, isUsable)).toEqual(fallback);
  });

  it('都不可用返回 undefined', () => {
    expect(pickBotModel(undefined, {}, isUsable)).toBeUndefined();
  });
});

it('只读档禁用写工具与后台任务', () => {
  expect(BOT_READONLY_DISABLED_TOOLS).toEqual(['workspace_write', 'background_tasks']);
});
