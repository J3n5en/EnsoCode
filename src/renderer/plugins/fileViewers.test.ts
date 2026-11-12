import { describe, expect, it } from 'vitest';
import { type PluginFileViewerRef, pluginFileViewersFor } from './fileViewers';

const viewer = (id: string, extensions: string[], isDefault = false): PluginFileViewerRef => ({
  pluginId: 'p',
  pluginName: 'P',
  id,
  title: id,
  entry: `${id}.html`,
  extensions,
  default: isDefault,
});

describe('pluginFileViewersFor', () => {
  const viewers = [
    viewer('json', ['.json']),
    viewer('draw', ['.excalidraw.json', '.excalidraw'], true),
    viewer('csv', ['.csv']),
  ];

  it('按后缀匹配，忽略大小写，长后缀排前面', () => {
    expect(pluginFileViewersFor('a/b.CSV', viewers).map((v) => v.id)).toEqual(['csv']);
    expect(pluginFileViewersFor('x.excalidraw.json', viewers).map((v) => v.id)).toEqual([
      'draw',
      'json',
    ]);
    expect(pluginFileViewersFor('x.excalidraw', viewers).map((v) => v.id)).toEqual(['draw']);
    expect(pluginFileViewersFor('x.md', viewers)).toEqual([]);
  });

  it('文件名正好等于后缀时不匹配', () => {
    expect(pluginFileViewersFor('dir/.csv', viewers)).toEqual([]);
  });
});
