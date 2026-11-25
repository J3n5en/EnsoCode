import { describe, expect, it } from 'vitest';
import {
  nodeMainRendererPath,
  nodeShellRoute,
  nodeShellUrl,
  parseNodeSettingsUrl,
} from './nodeSettings';

describe('node settings url', () => {
  it('nodeId 编码进 host，往返一致（大小写与特殊字符不丢）', () => {
    const url = nodeShellUrl('Ab_-9/x');
    expect(url).toMatch(/^enso-node:\/\/[0-9a-f]+\/shell\.html$/);
    expect(parseNodeSettingsUrl(url)).toEqual({ nodeId: 'Ab_-9/x', path: 'shell.html' });
  });

  it('拆出资源路径，拒绝坏输入', () => {
    const base = nodeShellUrl('n1').replace('shell.html', '');
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
  it('壳页只有主界面一种', () => {
    expect(nodeShellRoute(nodeShellUrl('n1'))).toEqual({ kind: 'shell' });
  });

  it('壳页跳到的主界面顶层文档带宿主平台', () => {
    const href = new URL(nodeMainRendererPath('darwin'), nodeShellUrl('n1')).href;
    expect(href).toMatch(/^enso-node:\/\/[0-9a-f]+\/r\/index\.html\?/);
    expect(nodeShellRoute(href)).toEqual({ kind: 'main', platform: 'darwin' });
  });

  it('其余文档（资源、缺平台、外站）不是壳也不是主界面', () => {
    const base = nodeShellUrl('n1').replace(/shell\.html.*$/, '');
    expect(nodeShellRoute(`${base}r/index.html`)).toBeNull();
    expect(nodeShellRoute(`${base}r/assets/a.js?platform=darwin`)).toBeNull();
    expect(nodeShellRoute('https://x/shell.html?page=main')).toBeNull();
  });
});
