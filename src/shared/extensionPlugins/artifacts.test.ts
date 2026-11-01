import { describe, expect, it } from 'vitest';
import { pluginArtifactsFromToolDetails } from './artifacts';

const info = {
  id: 'art_1',
  pluginId: 'enso.example.notes',
  name: '报告.txt',
  mime: 'text/plain',
  size: 12,
  createdAt: 1,
};

describe('工具结果里的产出文件', () => {
  it('从 details.artifacts 取出完整产出信息', () => {
    expect(
      pluginArtifactsFromToolDetails({
        details: { ignored: true },
        artifacts: [info, { ...info, id: 'art_2', mime: 'image/png', name: '图.png' }],
      })
    ).toEqual([info, { ...info, id: 'art_2', mime: 'image/png', name: '图.png' }]);
  });

  it('缺字段、非对象和没有 artifacts 时不编造产出', () => {
    expect(pluginArtifactsFromToolDetails(null)).toEqual([]);
    expect(pluginArtifactsFromToolDetails({ artifacts: 'art_1' })).toEqual([]);
    expect(pluginArtifactsFromToolDetails({ artifacts: ['art_1', { id: 'x' }, info] })).toEqual([
      info,
    ]);
    expect(pluginArtifactsFromToolDetails({ details: { artifacts: [info] } })).toEqual([]);
  });
});
