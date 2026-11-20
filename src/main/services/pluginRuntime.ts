import { createHash } from 'node:crypto';
import { isReservedAgentTypeName } from '../../shared/builtinAgents';
import type { AgentTypeSpawnConfig } from '../../shared/types/agent';
import { type AgentTypeEntry, BUILTIN_AGENT_TYPES } from '../../shared/types/assets';

export type RuntimeAgentType = AgentTypeEntry & { pluginSkillPaths?: string[] };

/** 原生 Enso 插件（enso-plugin.json）声明的子代理类型；正文与技能目录已由插件服务解析 */
export interface NativePluginAgentDef {
  pluginId: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: AgentTypeSpawnConfig['tools'];
  skillPaths: string[];
  modelMode?: 'agent_pick';
}

/** 合并时因重名被丢弃的插件类型；shadowedBy 是占住名字的一方 */
export interface PluginAgentTypeDrop {
  name: string;
  source: 'native';
  pluginId?: string;
  shadowedBy: 'custom' | 'builtin' | 'native';
}

export interface NativeAgentTypeSource {
  list(): NativePluginAgentDef[];
  reportDropped?(dropped: PluginAgentTypeDrop[]): void;
}

let nativeSource: NativeAgentTypeSource | null = null;

/** Enso 插件服务创建时注入；每次合并现取，停用/卸载立即生效 */
export function setNativeAgentTypeSource(source: NativeAgentTypeSource | null): void {
  nativeSource = source;
}

/** 名字派生的稳定 UUID（v5 位型）：registry 的 custom typeKey 需要 UUID */
export function pluginAgentTypeId(name: string): string {
  const hex = createHash('sha1').update(`enso-plugin-agent:${name}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + hex.slice(18, 20),
    hex.slice(20, 32),
  ].join('-');
}

const nameKey = (name: string) => name.trim().toLowerCase();

const toRuntime = (agent: NativePluginAgentDef): RuntimeAgentType => ({
  id: pluginAgentTypeId(agent.name),
  name: agent.name,
  description: agent.description || agent.name,
  systemPrompt: agent.systemPrompt,
  tools: agent.tools,
  modelMode: agent.modelMode ?? 'follow',
  pluginSkillPaths: agent.skillPaths,
});

/**
 * 同名优先级：用户自定义 > 原生插件（按插件 id 排序，先到先得）。
 * 原生插件另不能占用内置类型名与保留名。
 */
export function mergePluginAgentTypes(
  custom: readonly AgentTypeEntry[],
  native: readonly NativePluginAgentDef[]
): { types: RuntimeAgentType[]; dropped: PluginAgentTypeDrop[] } {
  const dropped: PluginAgentTypeDrop[] = [];
  const owner = new Map<string, PluginAgentTypeDrop['shadowedBy']>(
    custom.map((entry) => [nameKey(entry.name), 'custom'])
  );
  const nativeTypes: NativePluginAgentDef[] = [];
  const ordered = [...native].sort((a, b) =>
    a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0
  );
  for (const agent of ordered) {
    const key = nameKey(agent.name);
    const shadowedBy =
      isReservedAgentTypeName(agent.name) || BUILTIN_AGENT_TYPES.some((b) => b.name === key)
        ? 'builtin'
        : owner.get(key);
    if (shadowedBy) {
      dropped.push({ name: agent.name, source: 'native', pluginId: agent.pluginId, shadowedBy });
      continue;
    }
    owner.set(key, 'native');
    nativeTypes.push(agent);
  }
  return { types: [...custom, ...nativeTypes.map(toRuntime)], dropped };
}

/**
 * 用户自定义类型 + 已启用原生插件的子代理。
 * native 缺省取已注册来源；显式传入（如 Bot 会话传空）时以传入为准。
 */
export function withPluginAgentTypes(
  custom: readonly AgentTypeEntry[],
  native?: readonly NativePluginAgentDef[]
): RuntimeAgentType[] {
  const source = nativeSource;
  const { types, dropped } = mergePluginAgentTypes(custom, native ?? source?.list() ?? []);
  if (dropped.length > 0) source?.reportDropped?.(dropped);
  return types;
}
