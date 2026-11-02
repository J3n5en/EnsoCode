import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTypeEntry } from '../../shared/types/assets';
import type { PluginAgentDef, ResolvedPlugins } from './claudePlugins';
import {
  mergePluginAgentTypes,
  type NativePluginAgentDef,
  pluginAgentTypeId,
  setNativeAgentTypeSource,
  withPluginAgentTypes,
} from './pluginRuntime';

const custom = (name: string): AgentTypeEntry => ({
  id: '11111111-1111-4111-8111-111111111111',
  name,
  description: 'user',
  systemPrompt: 'user prompt',
  tools: 'all',
});
const claude = (name: string): PluginAgentDef => ({
  name,
  description: 'claude',
  systemPrompt: 'claude prompt',
  tools: 'all',
  skillPaths: [],
});
const native = (
  pluginId: string,
  name: string,
  patch: Partial<NativePluginAgentDef> = {}
): NativePluginAgentDef => ({
  pluginId,
  name,
  description: `native ${pluginId}`,
  systemPrompt: `prompt ${pluginId}`,
  tools: 'all',
  skillPaths: [],
  ...patch,
});
const resolved = (agents: PluginAgentDef[]): ResolvedPlugins => ({
  skillPaths: [],
  commands: [],
  agents,
  mcpServers: [],
  hooks: [],
});

afterEach(() => setNativeAgentTypeSource(null));

describe('mergePluginAgentTypes', () => {
  it('原生插件类型转成 RuntimeAgentType：tools 原样采用、skills 进 pluginSkillPaths', () => {
    const { types, dropped } = mergePluginAgentTypes(
      [],
      [],
      [
        native('example.a', 'a:reader', {
          tools: 'readonly',
          skillPaths: ['/plugins/a/skills/review'],
        }),
      ]
    );
    expect(dropped).toEqual([]);
    expect(types).toEqual([
      {
        id: pluginAgentTypeId('a:reader'),
        name: 'a:reader',
        description: 'native example.a',
        systemPrompt: 'prompt example.a',
        tools: 'readonly',
        modelMode: 'follow',
        pluginSkillPaths: ['/plugins/a/skills/review'],
      },
    ]);
  });

  it('同名优先级：用户自定义 > Claude 插件 > 原生插件，被丢弃的重名在返回值里', () => {
    const { types, dropped } = mergePluginAgentTypes(
      [custom('Shared')],
      [claude('shared'), claude('cp:agent')],
      [native('example.a', 'shared'), native('example.a', 'cp:agent')]
    );
    expect(types.map((t) => [t.name, t.description])).toEqual([
      ['Shared', 'user'],
      ['cp:agent', 'claude'],
    ]);
    expect(dropped).toEqual([
      { name: 'shared', source: 'claude', shadowedBy: 'custom' },
      { name: 'shared', source: 'native', pluginId: 'example.a', shadowedBy: 'custom' },
      { name: 'cp:agent', source: 'native', pluginId: 'example.a', shadowedBy: 'claude' },
    ]);
  });

  it('原生插件之间按插件 id 排序先到先得，与输入顺序无关', () => {
    const { types, dropped } = mergePluginAgentTypes(
      [],
      [],
      [native('example.b', 'same'), native('example.a', 'same'), native('example.b', 'only-b')]
    );
    expect(types.map((t) => [t.name, t.description])).toEqual([
      ['same', 'native example.a'],
      ['only-b', 'native example.b'],
    ]);
    expect(dropped).toEqual([
      { name: 'same', source: 'native', pluginId: 'example.b', shadowedBy: 'native' },
    ]);
  });

  it('原生插件不能占用内置类型名或保留名', () => {
    const { types, dropped } = mergePluginAgentTypes(
      [],
      [],
      [native('example.a', 'worker'), native('example.a', 'custom:x')]
    );
    expect(types).toEqual([]);
    expect(dropped.map((d) => d.shadowedBy)).toEqual(['builtin', 'builtin']);
  });
});

describe('withPluginAgentTypes 接原生插件来源', () => {
  it('现取已注册来源，并把丢弃的重名报回来源', () => {
    const reportDropped = vi.fn();
    let list = [native('example.a', 'helper'), native('example.a', 'cp:agent')];
    setNativeAgentTypeSource({ list: () => list, reportDropped });
    const merged = withPluginAgentTypes([], undefined, resolved([claude('cp:agent')]));
    expect(merged.map((t) => t.name)).toEqual(['cp:agent', 'helper']);
    expect(reportDropped).toHaveBeenCalledWith([
      { name: 'cp:agent', source: 'native', pluginId: 'example.a', shadowedBy: 'claude' },
    ]);

    list = [];
    expect(withPluginAgentTypes([], undefined, resolved([])).map((t) => t.name)).toEqual([]);
  });

  it('显式传入的原生列表优先于已注册来源（Bot 会话传空）', () => {
    setNativeAgentTypeSource({ list: () => [native('example.a', 'helper')] });
    expect(withPluginAgentTypes([], undefined, resolved([]), [])).toEqual([]);
  });
});
