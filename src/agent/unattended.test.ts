import { splitUnattendedPrefix } from '@shared/unattendedNote';
import { describe, expect, it } from 'vitest';
import { ASK_NO_USER_ERROR } from './ask';
import {
  consumeUnattendedNote,
  UNATTENDED_OFF_NOTE,
  UNATTENDED_ON_NOTE,
  UNATTENDED_PROMPT,
  UNATTENDED_RELAY_ON_NOTE,
  UNATTENDED_RELAY_PROMPT,
  unattendedPrompt,
  unattendedSwitchNote,
} from './unattended';

describe('普通无人值守原文锁定（没有 askRelay 时一个字都不能变）', () => {
  it('常驻说明', () => {
    expect(UNATTENDED_PROMPT).toMatchInlineSnapshot(`
      "<unattended>
      This session has no human watching it.
      - Asking is not available: ask_user and any action that needs confirmation fail immediately with a "no user available" error. Nothing waits for a reply, and no answer will arrive later in this turn.
      - Never ask a question in prose and stop, and never say you are waiting for approval. If you were about to ask, decide instead.
      - Decide on the most reasonable assumption, state it in one line, and keep working.
      - Stop only when a decision is irreversible and would change the user's data, account or money, or when the work cannot continue without it. Then say plainly which decision is needed and what you already did.
      - When you finish, call goal_complete with an optional result. Example: {"summary":"shipped","prs":[{"repo":"owner/repo","number":1,"state":"merged"}],"commits":["abc1234"]}
      </unattended>"
    `);
  });

  it('热切换提示', () => {
    expect(UNATTENDED_ON_NOTE).toMatchInlineSnapshot(`
      "<unattended>
      Unattended mode is ON: this session has no human watching it. ask_user and actions that need confirmation now fail immediately, so nothing waits for an answer.
      Do not ask in prose and wait. Decide on the most reasonable assumption, state it, and keep going; stop only for an irreversible decision that changes the user's data, account or money.
      </unattended>"
    `);
    expect(UNATTENDED_OFF_NOTE).toMatchInlineSnapshot(`
      "<unattended>
      Unattended mode is OFF: a human is available again. ask_user and approval requests now reach them and wait for an answer.
      </unattended>"
    `);
  });

  it('ask_user 的拒绝文案', () => {
    expect(ASK_NO_USER_ERROR).toMatchInlineSnapshot(
      `"Blocked: this session has no user available to answer questions, and asking is not available here. Do not ask in prose and wait. Decide on the most reasonable assumption, state it in one line, and continue. Stop only if the decision is irreversible and would change the user's data — then say which decision is needed and what you already did."`
    );
  });
});

describe('无人值守的模型侧说明', () => {
  it('常驻说明点名「没人在线」，并堵掉「反问后停下等人」这条路', () => {
    expect(UNATTENDED_PROMPT).toMatch(/no human watching/i);
    expect(UNATTENDED_PROMPT).toMatch(/ask_user and any action that needs confirmation fail/i);
    expect(UNATTENDED_PROMPT).toMatch(/nothing waits for a reply/i);
    expect(UNATTENDED_PROMPT).toMatch(/Never ask a question in prose and stop/i);
  });

  it('主位是「继续干活」，停下只留给不可逆且动用户数据的决定', () => {
    expect(UNATTENDED_PROMPT).toMatch(/most reasonable assumption, state it in one line/i);
    expect(UNATTENDED_PROMPT).toMatch(/Stop only when a decision is irreversible/i);
    // 「停下」必须附带「说清需要什么决定」，否则模型只会留一句反问
    expect(UNATTENDED_PROMPT).toMatch(/which decision is needed and what you already did/i);
  });

  it('开关翻转的一次性提示与 plan-mode 同一包裹形式，语义互斥', () => {
    expect(UNATTENDED_ON_NOTE.startsWith('<unattended>')).toBe(true);
    expect(UNATTENDED_ON_NOTE).toMatch(/no human watching/i);
    expect(UNATTENDED_ON_NOTE).toMatch(/Do not ask in prose and wait/i);
    expect(UNATTENDED_OFF_NOTE.startsWith('<unattended>')).toBe(true);
    expect(UNATTENDED_OFF_NOTE).toMatch(/a human is available again/i);
    expect(UNATTENDED_OFF_NOTE).toMatch(/wait for an answer/i);
  });
});

describe('有提问转发（askRelay）的无人值守变体', () => {
  it('常驻说明：提问转给秘书，技术细节自己定，取舍/不可逆/需求不明才问', () => {
    expect(UNATTENDED_RELAY_PROMPT.startsWith('<unattended>')).toBe(true);
    expect(UNATTENDED_RELAY_PROMPT).toMatch(/no human watching/i);
    expect(UNATTENDED_RELAY_PROMPT).toMatch(/secretary/i);
    expect(UNATTENDED_RELAY_PROMPT).toMatch(/technical details/i);
    expect(UNATTENDED_RELAY_PROMPT).toMatch(/Use ask_user for product trade-offs/i);
    expect(UNATTENDED_RELAY_PROMPT).toMatch(/irreversible/i);
    expect(UNATTENDED_RELAY_PROMPT).toMatch(/merging to main/i);
    expect(UNATTENDED_RELAY_PROMPT).toMatch(/default_option/);
    expect(UNATTENDED_RELAY_PROMPT).toMatch(/wait for the answer/i);
    expect(UNATTENDED_RELAY_PROMPT).toMatch(/need approval are still rejected/i);
    // 不能沿用「提问不可用」的说法，否则模型照旧不问
    expect(UNATTENDED_RELAY_PROMPT).not.toMatch(/Asking is not available/i);
  });

  it('按是否转发选常驻说明；没有转发时就是原文', () => {
    expect(unattendedPrompt(false)).toBe(UNATTENDED_PROMPT);
    expect(unattendedPrompt(true)).toBe(UNATTENDED_RELAY_PROMPT);
  });

  it('热切换提示被展示层识别为「开启」', () => {
    expect(splitUnattendedPrefix(`${UNATTENDED_RELAY_ON_NOTE}\n\n继续`)).toEqual({
      note: 'on',
      rest: '继续',
    });
    expect(UNATTENDED_RELAY_ON_NOTE).toMatch(/secretary/i);
    expect(UNATTENDED_RELAY_ON_NOTE).toMatch(/default_option/);
  });
});

describe('状态变化对应的一次性提示', () => {
  const s = (autoReject: boolean, relay: boolean) => ({ autoReject, relay });

  it('普通无人值守开关：与原来一样只发 ON / OFF', () => {
    expect(unattendedSwitchNote(s(false, false), s(true, false))).toBe(UNATTENDED_ON_NOTE);
    expect(unattendedSwitchNote(s(true, false), s(false, false))).toBe(UNATTENDED_OFF_NOTE);
    expect(unattendedSwitchNote(s(true, false), s(true, false))).toBeUndefined();
    expect(unattendedSwitchNote(s(false, false), s(false, false))).toBeUndefined();
  });

  it('有转发时打开无人值守用转发变体；关闭照旧 OFF', () => {
    expect(unattendedSwitchNote(s(false, true), s(true, true))).toBe(UNATTENDED_RELAY_ON_NOTE);
    expect(unattendedSwitchNote(s(true, true), s(false, true))).toBe(UNATTENDED_OFF_NOTE);
  });

  it('无人值守中途开关转发：切到对应变体', () => {
    expect(unattendedSwitchNote(s(true, false), s(true, true))).toBe(UNATTENDED_RELAY_ON_NOTE);
    expect(unattendedSwitchNote(s(true, true), s(true, false))).toBe(UNATTENDED_ON_NOTE);
  });

  it('有人值守时开关转发不发提示', () => {
    expect(unattendedSwitchNote(s(false, false), s(false, true))).toBeUndefined();
    expect(unattendedSwitchNote(s(false, true), s(false, false))).toBeUndefined();
  });
});

describe('一次性提示的消费', () => {
  it('只在有提示时前置，且消费一次', () => {
    const state: { unattendedNote?: string } = {};
    expect(consumeUnattendedNote(state, '继续')).toBe('继续');

    state.unattendedNote = UNATTENDED_ON_NOTE;
    expect(consumeUnattendedNote(state, '继续')).toBe(`${UNATTENDED_ON_NOTE}\n\n继续`);
    state.unattendedNote = UNATTENDED_ON_NOTE;
    expect(consumeUnattendedNote(state, '/skill:a 继续')).toBe(
      `/skill:a ${UNATTENDED_ON_NOTE}\n\n继续`
    );
    expect(state.unattendedNote).toBeUndefined();
    expect(consumeUnattendedNote(state, '下一句')).toBe('下一句');
  });
});
