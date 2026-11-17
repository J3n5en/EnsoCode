import { describe, expect, it } from 'vitest';
import {
  nodeMainRendererPath,
  nodeShellRoute,
  nodeShellUrl,
  parseNodeSettingsUrl,
} from './nodeSettings';

describe('node settings url', () => {
  it('nodeId 编码进 host，往返一致（大小写与特殊字符不丢）', () => {
    const url = nodeShellUrl('Ab_-9/x', 'settings');
    expect(url).toMatch(/^enso-node:\/\/[0-9a-f]+\/shell\.html$/);
    expect(parseNodeSettingsUrl(url)).toEqual({ nodeId: 'Ab_-9/x', path: 'shell.html' });
  });

  it('拆出资源路径，拒绝坏输入', () => {
    const base = nodeShellUrl('n1', 'settings').replace('shell.html', '');
    expect(parseNodeSettingsUrl(`${base}r/assets/a.js?v=1`)).toEqual({
      nodeId: 'n1',
      path: 'r/assets/a.js',
    });
    expect(parseNodeSettingsUrl('https://x/shell.html')).toBeNull();
    expect(parseNodeSettingsUrl('enso-node://zz/shell.html')).toBeNull();
    expect(parseNodeSettingsUrl('enso-node:///shell.html')).toBeNull();
  });
});

describe('node shell route', () => {
  it('壳页按 page 区分主界面与设置页，缺省为设置页', () => {
    expect(nodeShellRoute(nodeShellUrl('n1', 'main'))).toEqual({ kind: 'shell', page: 'main' });
    expect(nodeShellRoute(nodeShellUrl('n1', 'settings'))).toEqual({
      kind: 'shell',
      page: 'settings',
    });
  });

  it('壳页跳到的主界面顶层文档带宿主平台', () => {
    const href = new URL(nodeMainRendererPath('darwin'), nodeShellUrl('n1', 'main')).href;
    expect(href).toMatch(/^enso-node:\/\/[0-9a-f]+\/r\/index\.html\?/);
    expect(nodeShellRoute(href)).toEqual({ kind: 'main', platform: 'darwin' });
  });

  it('其余文档（设置 iframe、资源、缺平台、外站）不是壳也不是主界面', () => {
    const base = nodeShellUrl('n1', 'main').replace(/shell\.html.*$/, '');
    expect(nodeShellRoute(`${base}r/settings.html`)).toBeNull();
    expect(nodeShellRoute(`${base}r/index.html`)).toBeNull();
    expect(nodeShellRoute(`${base}r/assets/a.js?platform=darwin`)).toBeNull();
    expect(nodeShellRoute('https://x/shell.html?page=main')).toBeNull();
  });
});
