import { describe, expect, it } from 'vitest';
import {
  pluginInstallSettingsLink,
  pluginInstallUrlFromLink,
  pluginInstallUrlsFromArgv,
} from './pluginProtocol';

const SOURCE = 'https://github.com/acme/demo';
const LINK = `enso://install-plugin?url=${encodeURIComponent(SOURCE)}`;

describe('pluginInstallUrlFromLink', () => {
  it('取出插件 https 地址', () => {
    expect(pluginInstallUrlFromLink(LINK)).toBe(SOURCE);
    expect(pluginInstallUrlFromLink(`  ${LINK}  `)).toBe(SOURCE);
  });

  it('拒绝配对链接、别的 scheme 和非法安装地址', () => {
    expect(pluginInstallUrlFromLink('enso://pair?relay=x&pk=y')).toBeNull();
    expect(pluginInstallUrlFromLink('https://github.com/acme/demo')).toBeNull();
    expect(
      pluginInstallUrlFromLink(
        `enso://install-plugin?url=${encodeURIComponent('file:///tmp/plugin.zip')}`
      )
    ).toBeNull();
    expect(pluginInstallUrlFromLink('enso://install-plugin')).toBeNull();
    expect(pluginInstallUrlFromLink('not a url')).toBeNull();
  });
});

describe('pluginInstallUrlsFromArgv', () => {
  it('只收集安装链接并去重', () => {
    expect(pluginInstallUrlsFromArgv(['--', LINK, 'enso://pair?relay=x', LINK])).toEqual([SOURCE]);
  });
});

describe('pluginInstallSettingsLink', () => {
  it('落到 Enso 插件设置行并带上安装地址', () => {
    expect(pluginInstallSettingsLink(SOURCE)).toEqual({
      category: 'plugins',
      rowId: 'plugins.enso',
      pluginInstallUrl: SOURCE,
    });
  });
});
