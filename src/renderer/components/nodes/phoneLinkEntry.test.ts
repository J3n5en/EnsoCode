import { describe, expect, it } from 'vitest';
import { phoneLinkEntry, showCompactButton } from './phoneLinkEntry';

const link = { linkStatus: () => ({}) as never, onLinkStatus: () => () => {} };
const noop = () => {};

describe('phoneLinkEntry', () => {
  it('新版手机壳：电脑标签，「精简版」收进抽屉', () => {
    const remote = { ...link, openDevices: noop, exitDesk: noop };
    expect(phoneLinkEntry(remote)).toBe('devices');
    expect(showCompactButton(remote)).toBe(false);
  });

  it('旧版壳没有 openDevices：保留 Info 弹层和「精简版」按钮', () => {
    const remote = { ...link, exitDesk: noop };
    expect(phoneLinkEntry(remote)).toBe('info');
    expect(showCompactButton(remote)).toBe(true);
  });

  it('电脑上（Electron 无 remote、节点层没有手机链路）都不显示', () => {
    expect(phoneLinkEntry(undefined)).toBeNull();
    expect(showCompactButton(undefined)).toBe(false);
    expect(phoneLinkEntry({})).toBeNull();
    expect(showCompactButton({})).toBe(false);
  });
});
