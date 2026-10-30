import { AX_STALE_HANDLE, parseAxHandle } from '@shared/computer/axRegistry';
import { describe, expect, it } from 'vitest';
import { AxHandleTable, axAttributePairs, axSetValueRejection } from './axNative';

function table(epoch = 'e1') {
  const retained: string[] = [];
  const released: string[] = [];
  const handles = new AxHandleTable<string>(epoch, {
    retain: (value) => retained.push(value),
    release: (value) => released.push(value),
  });
  return { handles, retained, released };
}

describe('AxHandleTable', () => {
  it('提供元素身份时，同 scope 相等元素跨代复用句柄且不重复 retain', () => {
    const retained: string[] = [];
    const released: string[] = [];
    const handles = new AxHandleTable<string>('k1', {
      retain: (value) => retained.push(value),
      release: (value) => released.push(value),
      hash: (value) => value.toLowerCase().charCodeAt(0),
      equals: (a, b) => a.toLowerCase() === b.toLowerCase(),
    });
    const first = handles.add('A', handles.begin('pid:1'));
    const second = handles.add('a', handles.begin('pid:1'));
    expect(second).toBe(first);
    expect(retained).toEqual(['A']);
    handles.begin('pid:1');
    // 第 2 代续命：第 3 代时仍在两代窗口内
    expect(released).toEqual([]);
    handles.begin('pid:1');
    expect(released).toEqual(['A']);
    expect(handles.size).toBe(0);
  });

  it('不同 scope 不复用；没有身份函数时保持每次新句柄', () => {
    const { handles } = table();
    const a = handles.add('A', handles.begin('pid:1'));
    expect(handles.add('A', handles.begin('pid:1'))).not.toBe(a);
    const withIdentity = new AxHandleTable<string>('k2', {
      retain: () => {},
      release: () => {},
      hash: () => 1,
      equals: (x, y) => x === y,
    });
    const p1 = withIdentity.add('A', withIdentity.begin('pid:1'));
    expect(withIdentity.add('A', withIdentity.begin('desktop'))).not.toBe(p1);
  });

  it('句柄带纪元并持有独立引用', () => {
    const { handles, retained } = table('k9');
    const scope = handles.begin('pid:1');
    const ref = handles.add('A', scope);
    expect(parseAxHandle(ref)?.epoch).toBe('k9');
    expect(retained).toEqual(['A']);
    expect(handles.get(ref)).toBe('A');
  });

  it('同 scope 新一代开始时释放更早的代，只保留两代', () => {
    const { handles, released } = table();
    const a = handles.add('A', handles.begin('pid:1'));
    const b = handles.add('B', handles.begin('pid:1'));
    const other = handles.add('X', handles.begin('pid:2'));
    expect(released).toEqual([]);
    handles.begin('pid:1');
    expect(released).toEqual(['A']);
    expect(() => handles.get(a)).toThrow(AX_STALE_HANDLE);
    expect(handles.get(b)).toBe('B');
    expect(handles.get(other)).toBe('X');
    expect(handles.size).toBe(2);
  });

  it('子节点继承父句柄的代，随父一起回收', () => {
    const { handles, released } = table();
    const parent = handles.add('P', handles.begin('pid:1'));
    const child = handles.add('C', handles.scopeOf(parent));
    handles.begin('pid:1');
    handles.begin('pid:1');
    expect(released.sort()).toEqual(['C', 'P']);
    expect(() => handles.get(child)).toThrow(AX_STALE_HANDLE);
  });

  it('已过期的代再 add 不持有引用', () => {
    const { handles, retained } = table();
    const old = handles.begin('pid:1');
    handles.begin('pid:1');
    handles.begin('pid:1');
    const ref = handles.add('late', old);
    expect(retained).toEqual([]);
    expect(() => handles.get(ref)).toThrow(AX_STALE_HANDLE);
  });

  it('其它纪元或旧格式句柄是过期错误', () => {
    const { handles } = table('mine');
    handles.add('A', handles.begin('pid:1'));
    expect(() => handles.get('ax-other-1')).toThrow(AX_STALE_HANDLE);
    expect(() => handles.get('ax1')).toThrow(AX_STALE_HANDLE);
    expect(() => handles.scopeOf('ax-other-1')).toThrow(AX_STALE_HANDLE);
  });
});

describe('axAttributePairs', () => {
  it('树里可见的 description/value 也要出现在 attributes()', () => {
    expect(
      axAttributePairs({ ref: 'ax-a-1', role: 'AXSlider', description: '亮度', value: '0.5' })
    ).toEqual([
      ['role', 'AXSlider'],
      ['value', '0.5'],
      ['description', '亮度'],
    ]);
    expect(axAttributePairs({ ref: 'ax-a-1', role: 'AXButton', title: 'OK' })).toEqual([
      ['role', 'AXButton'],
      ['title', 'OK'],
    ]);
  });
});

describe('axSetValueRejection', () => {
  it('AXValue 不可设置时拒绝写入并指向可用 action', () => {
    const message = axSetValueRejection({
      role: 'AXSlider',
      settable: false,
      actions: ['AXIncrement', 'AXDecrement'],
    });
    expect(message).toContain('AXSlider');
    expect(message).toContain('AXIncrement');
    expect(message).toContain('AXDecrement');
  });

  it('可设置时放行', () => {
    expect(axSetValueRejection({ role: 'AXTextField', settable: true, actions: [] })).toBe(
      undefined
    );
  });
});
