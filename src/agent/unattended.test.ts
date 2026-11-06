import { describe, expect, it } from 'vitest';
import {
  consumeUnattendedNote,
  UNATTENDED_OFF_NOTE,
  UNATTENDED_ON_NOTE,
  UNATTENDED_PROMPT,
} from './unattended';

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
