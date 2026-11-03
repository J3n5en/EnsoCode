import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLUGIN_HOST_APIS } from './protocol';
import './authorApi';

describe('enso 插件类型声明', () => {
  it('protocol.ts 的每个宿主方法在声明文件里都有对应项', () => {
    const text = readFileSync(new URL('../../../types/enso-plugin.d.ts', import.meta.url), 'utf8');
    for (const api of PLUGIN_HOST_APIS) expect(text).toContain(`'${api}'`);
  });
});
