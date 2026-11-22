import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { StoredDevice } from './deviceList';
import { launchTarget, UI_MODE_KEY, type UiMode } from './uiMode';

/** index.html 里模块脚本之前的内联跳转：必须与 launchTarget 判定一致 */
const html = readFileSync(path.resolve(import.meta.dirname, '../index.html'), 'utf8');
const inline = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

function runInline(search: string, items: Record<string, string>): string | null {
  let target: string | null = null;
  vm.runInNewContext(inline, {
    URLSearchParams,
    localStorage: { getItem: (key: string) => items[key] ?? null },
    location: {
      search,
      replace: (url: string) => {
        target = url;
      },
    },
  });
  return target;
}

const device = (pairId: string, scope?: 'read' | 'operate') =>
  ({ pairId, label: pairId, scope }) as unknown as StoredDevice;

describe('index.html 内联直达 /desk', () => {
  it('脚本存在且排在模块脚本之前', () => {
    expect(inline).toContain('location.replace');
    expect(html.indexOf(inline)).toBeLessThan(html.indexOf('type="module"'));
  });

  const cases: [string, UiMode, StoredDevice[], string | null][] = [
    ['', 'desk', [device('a'), device('b', 'operate')], 'b'],
    ['', 'desk', [device('a'), device('b')], 'gone'],
    ['', 'desk', [device('a/b')], null],
    ['', 'phone', [device('a')], 'a'],
    ['', 'desk', [], null],
    ['', 'desk', [device('a', 'read')], 'a'],
    ['?mode=phone', 'desk', [device('a')], 'a'],
    ['?session=s1&mode=phone', 'desk', [device('a')], 'a'],
    ['?session=s1', 'desk', [device('a')], 'a'],
    ['?session=%20s1%20', 'desk', [device('a')], 'a'],
    ['?session=bad id', 'desk', [device('a')], 'a'],
    [`?session=${'x'.repeat(201)}`, 'desk', [device('a')], 'a'],
    ['?session=s1', 'phone', [device('a')], 'a'],
    ['?pair=desk', 'desk', [device('a')], 'a'],
  ];
  it.each(cases)('search=%j mode=%s 与 launchTarget 一致', (search, mode, devices, activeId) => {
    const items: Record<string, string> = {
      [UI_MODE_KEY]: mode,
      'enso-phone-devices': JSON.stringify(devices),
    };
    if (activeId) items['enso-phone-active-device'] = activeId;
    expect(runInline(search, items)).toBe(launchTarget(search, mode, devices, activeId));
  });

  it('坏数据或旧版单配对键时不跳，交给入口脚本迁移', () => {
    expect(runInline('', { [UI_MODE_KEY]: 'desk', 'enso-phone-devices': '{bad' })).toBeNull();
    expect(runInline('', { [UI_MODE_KEY]: 'desk', 'enso-phone-devices': '[null]' })).toBeNull();
    expect(
      runInline('', { [UI_MODE_KEY]: 'desk', 'enso-phone-pairing': '{"pairId":"a"}' })
    ).toBeNull();
  });
});
