import { afterEach, describe, expect, it } from 'vitest';
import { pluginCommandFor, pluginSlashCommands, setPluginCommands } from './commands';

afterEach(() => setPluginCommands([]));

const notes = { pluginId: 'enso.example.notes', pluginName: 'Notes', id: 'refresh', title: '刷新' };

describe('插件斜杠命令', () => {
  it('命令名是 /<插件 id>:<命令 id>，描述带插件名', () => {
    setPluginCommands([notes]);
    expect(pluginSlashCommands()).toEqual([
      { name: '/enso.example.notes:refresh', description: '刷新 · Notes' },
    ]);
  });

  it('只认已登记的命令，其它斜杠命令不当作插件命令', () => {
    setPluginCommands([notes]);
    expect(pluginCommandFor('/enso.example.notes:refresh')).toEqual(notes);
    expect(pluginCommandFor('/enso.example.notes:other')).toBeNull();
    expect(pluginCommandFor('/skill:refresh')).toBeNull();
    setPluginCommands([]);
    expect(pluginCommandFor('/enso.example.notes:refresh')).toBeNull();
  });
});
