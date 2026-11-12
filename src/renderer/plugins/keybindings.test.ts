import { describe, expect, it } from 'vitest';
import { pluginKeybindingAction, resolvePluginKeybindings } from './keybindings';

const cmd = (pluginId: string, id: string, key?: string) => ({
  pluginId,
  pluginName: pluginId,
  id,
  title: id,
  ...(key ? { key } : {}),
});

describe('插件命令快捷键', () => {
  it('设置里的改键覆盖清单默认，空串表示禁用', () => {
    const a = cmd('p.a', 'run', 'mod+shift+k');
    const b = cmd('p.b', 'open', 'alt+o');
    const c = cmd('p.c', 'noop');
    const resolved = resolvePluginKeybindings(
      [a, b, c],
      {
        [pluginKeybindingAction('p.a', 'run')]: 'mod+shift+l',
        [pluginKeybindingAction('p.b', 'open')]: '',
      },
      {}
    );
    expect(resolved.byBinding.get('mod+shift+l')).toEqual(a);
    expect(resolved.byBinding.has('mod+shift+k')).toBe(false);
    expect(resolved.byBinding.has('alt+o')).toBe(false);
    expect(resolved.rows.map((row) => [row.action, row.binding, row.custom])).toEqual([
      ['plugin:p.a:run', 'mod+shift+l', true],
      ['plugin:p.b:open', '', true],
      ['plugin:p.c:noop', '', false],
    ]);
  });

  it('默认键与内置快捷键或先装插件冲突时不生效，并标出冲突对象', () => {
    const a = cmd('p.a', 'run', 'mod+b');
    const b = cmd('p.b', 'one', 'alt+x');
    const c = cmd('p.c', 'two', 'alt+x');
    const resolved = resolvePluginKeybindings([a, b, c], {}, { 'toggle-sidebar': 'mod+b' });
    expect(resolved.byBinding.get('mod+b')).toBeUndefined();
    expect(resolved.byBinding.get('alt+x')).toEqual(b);
    expect(resolved.rows.map((row) => [row.action, row.binding, row.conflict])).toEqual([
      ['plugin:p.a:run', 'mod+b', 'toggle-sidebar'],
      ['plugin:p.b:one', 'alt+x', undefined],
      ['plugin:p.c:two', 'alt+x', 'plugin:p.b:one'],
    ]);
  });
});
