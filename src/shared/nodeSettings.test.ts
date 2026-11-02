import { describe, expect, it } from 'vitest';
import { nodeSettingsUrl, parseNodeSettingsUrl } from './nodeSettings';

describe('node settings url', () => {
  it('nodeId 编码进 host，往返一致（大小写与特殊字符不丢）', () => {
    const url = nodeSettingsUrl('Ab_-9/x');
    expect(url).toMatch(/^enso-node:\/\/[0-9a-f]+\/shell\.html$/);
    expect(parseNodeSettingsUrl(url)).toEqual({ nodeId: 'Ab_-9/x', path: 'shell.html' });
  });

  it('拆出资源路径，拒绝坏输入', () => {
    const base = nodeSettingsUrl('n1').replace('shell.html', '');
    expect(parseNodeSettingsUrl(`${base}r/assets/a.js?v=1`)).toEqual({
      nodeId: 'n1',
      path: 'r/assets/a.js',
    });
    expect(parseNodeSettingsUrl('https://x/shell.html')).toBeNull();
    expect(parseNodeSettingsUrl('enso-node://zz/shell.html')).toBeNull();
    expect(parseNodeSettingsUrl('enso-node:///shell.html')).toBeNull();
  });
});
