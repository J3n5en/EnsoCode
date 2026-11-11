import { describe, expect, it } from 'vitest';
import { omitNamedTools } from './disallowedTools';

describe('omitNamedTools', () => {
  const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'ImageGen' }];

  it('空禁用列表保留全部工具', () => {
    expect(omitNamedTools(tools, [])).toEqual(tools);
  });

  it('按名字大小写不敏感地去掉工具，组 id 不影响其它工具', () => {
    expect(omitNamedTools(tools, ['Bash', 'web'])).toEqual([
      { name: 'read' },
      { name: 'ImageGen' },
    ]);
    expect(omitNamedTools(tools, ['imagegen'])).toEqual([{ name: 'bash' }, { name: 'read' }]);
  });
});
