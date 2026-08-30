import { describe, expect, it } from 'vitest';
import { applyProjectOrder, moveProject } from './projectOrder';

interface P {
  id: string;
}
const projects: P[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('applyProjectOrder', () => {
  it('按已存顺序重排', () => {
    expect(applyProjectOrder(projects, ['c', 'a', 'b']).map((p) => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('savedIds 里没有的新项目按原序追加末尾', () => {
    expect(applyProjectOrder(projects, ['c']).map((p) => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('savedIds 中已不存在的项目 id 忽略', () => {
    expect(applyProjectOrder(projects, ['ghost', 'b', 'a']).map((p) => p.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('空 savedIds 时保持原序', () => {
    expect(applyProjectOrder(projects, []).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('不修改入参数组', () => {
    const input = [...projects];
    applyProjectOrder(input, ['c', 'a']);
    expect(input.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('moveProject', () => {
  it('把 activeId 移到 overId 的位置,返回完整 id 顺序', () => {
    expect(moveProject(projects, [], 'a', 'c')).toEqual(['b', 'c', 'a']);
  });

  it('基于已存顺序移动', () => {
    expect(moveProject(projects, ['c', 'a', 'b'], 'b', 'c')).toEqual(['b', 'c', 'a']);
  });

  it('activeId 与 overId 相同时返回当前顺序', () => {
    expect(moveProject(projects, [], 'a', 'a')).toEqual(['a', 'b', 'c']);
  });

  it('未知 id 不移动', () => {
    expect(moveProject(projects, [], 'ghost', 'b')).toEqual(['a', 'b', 'c']);
  });
});
