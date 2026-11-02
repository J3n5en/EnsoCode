import { describe, expect, it } from 'vitest';
import { splitUnattendedPrefix } from './unattendedNote';

const ON = `<unattended>
Unattended mode is ON: this session has no human watching it.
</unattended>`;

const OFF = `<unattended>
Unattended mode is OFF: a human is available again.
</unattended>`;

describe('splitUnattendedPrefix', () => {
  it('剥掉打开提示，剩下用户原文', () => {
    expect(splitUnattendedPrefix(`${ON}\n\n这个美化一下`)).toEqual({
      note: 'on',
      rest: '这个美化一下',
    });
  });

  it('关闭提示单独成条时 rest 为空', () => {
    expect(splitUnattendedPrefix(OFF)).toEqual({ note: 'off', rest: '' });
  });

  it('普通消息不动', () => {
    expect(splitUnattendedPrefix('继续')).toEqual({ rest: '继续' });
  });
});
