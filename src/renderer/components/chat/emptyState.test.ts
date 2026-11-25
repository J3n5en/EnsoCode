import { describe, expect, it } from 'vitest';
import { emptyStateTitle } from './emptyState';

describe('emptyStateTitle', () => {
  it('普通会话用调用方给的标题', () => {
    expect(
      emptyStateTitle({ secretarySession: false, ownerName: '爱酱', fallback: 'MyProject' })
    ).toBe('MyProject');
  });

  it('秘书会话用所属秘书的名字，不用隐藏项目名', () => {
    expect(
      emptyStateTitle({ secretarySession: true, ownerName: 'Ken', fallback: 'Secretary' })
    ).toBe('Ken');
  });

  it('秘书档案还没加载好时回退到传入标题', () => {
    expect(
      emptyStateTitle({ secretarySession: true, ownerName: null, fallback: 'Secretary' })
    ).toBe('Secretary');
    expect(emptyStateTitle({ secretarySession: true, ownerName: '', fallback: 'Secretary' })).toBe(
      'Secretary'
    );
  });
});
