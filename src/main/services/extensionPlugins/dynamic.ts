import type { ExtensionPluginManifest } from '@shared/extensionPlugins/manifest';
import { MAX_TOOL_TIMEOUT_MS } from '@shared/extensionPlugins/manifest';
import { pluginToolName } from '@shared/extensionPlugins/toolName';
import { pluginError } from './process';

const TOOL = /^[a-z][a-z0-9_]*$/;
const LOCAL_ID = /^[a-z][a-z0-9-]{0,31}$/;

export interface DynamicTool {
  pluginId: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  timeoutMs?: number;
}

export interface DynamicCommand {
  pluginId: string;
  id: string;
  title: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 运行期工具与命令；进程退出后清空，不落盘 */
export class DynamicContribs {
  private tools: DynamicTool[] = [];
  private commands: DynamicCommand[] = [];

  register(
    pluginId: string,
    manifest: ExtensionPluginManifest,
    input: Record<string, unknown>
  ): void {
    if (input.kind === 'tool') this.registerTool(pluginId, manifest, input);
    else if (input.kind === 'command') this.registerCommand(pluginId, manifest, input);
    else throw pluginError('INVALID_ARGS', 'kind 不合法');
  }

  /** 只校验形状和配额，不写入。base 是已占用数量（试加载用） */
  validate(
    pluginId: string,
    manifest: ExtensionPluginManifest,
    input: Record<string, unknown>,
    base: { tools: number; commands: number }
  ): void {
    if (input.kind === 'tool') this.parseTool(pluginId, manifest, input, base.tools, false);
    else if (input.kind === 'command')
      this.parseCommand(pluginId, manifest, input, base.commands, false);
    else throw pluginError('INVALID_ARGS', 'kind 不合法');
  }

  unregister(pluginId: string, input: Record<string, unknown>): void {
    const name = input.name;
    if (typeof name !== 'string') throw pluginError('INVALID_ARGS', 'name 不合法');
    if (input.kind === 'tool')
      this.tools = this.tools.filter((t) => !(t.pluginId === pluginId && t.name === name));
    else if (input.kind === 'command')
      this.commands = this.commands.filter((c) => !(c.pluginId === pluginId && c.id === name));
    else throw pluginError('INVALID_ARGS', 'kind 不合法');
  }

  clear(pluginId: string): boolean {
    const before = this.tools.length + this.commands.length;
    this.tools = this.tools.filter((t) => t.pluginId !== pluginId);
    this.commands = this.commands.filter((c) => c.pluginId !== pluginId);
    return this.tools.length + this.commands.length !== before;
  }

  toolsFor(pluginId: string): DynamicTool[] {
    return this.tools.filter((t) => t.pluginId === pluginId);
  }

  commandsFor(pluginId: string): DynamicCommand[] {
    return this.commands.filter((c) => c.pluginId === pluginId);
  }

  private registerTool(
    pluginId: string,
    manifest: ExtensionPluginManifest,
    input: Record<string, unknown>
  ): void {
    this.tools.push(
      this.parseTool(pluginId, manifest, input, this.toolsFor(pluginId).length, true)
    );
  }

  private registerCommand(
    pluginId: string,
    manifest: ExtensionPluginManifest,
    input: Record<string, unknown>
  ): void {
    this.commands.push(
      this.parseCommand(pluginId, manifest, input, this.commandsFor(pluginId).length, true)
    );
  }

  private parseTool(
    pluginId: string,
    manifest: ExtensionPluginManifest,
    input: Record<string, unknown>,
    used: number,
    checkStore: boolean
  ): DynamicTool {
    const name = input.name;
    if (
      typeof name !== 'string' ||
      !TOOL.test(name) ||
      name.includes('__') ||
      pluginToolName(pluginId, name).length > 64
    )
      throw pluginError('INVALID_ARGS', `工具名不合法：${String(name)}`);
    if (manifest.contributes.agentTools.some((tool) => tool.name === name))
      throw pluginError('INVALID_ARGS', `工具 ${name} 已在清单里`);
    if (checkStore && this.tools.some((tool) => tool.pluginId === pluginId && tool.name === name))
      throw pluginError('INVALID_ARGS', `工具 ${name} 已注册`);
    if (used >= manifest.contributes.dynamic.tools) throw pluginError('QUOTA', '动态工具已达上限');
    if (
      typeof input.description !== 'string' ||
      !input.description.trim() ||
      input.description.length > 1024
    )
      throw pluginError('INVALID_ARGS', `工具 ${name} 的 description 不合法`);
    if (!isRecord(input.parameters) || input.parameters.type !== 'object')
      throw pluginError('INVALID_ARGS', `工具 ${name} 的 parameters 必须是 type=object`);
    const timeoutMs = input.timeoutMs;
    if (
      timeoutMs !== undefined &&
      !(
        typeof timeoutMs === 'number' &&
        Number.isInteger(timeoutMs) &&
        timeoutMs >= 1000 &&
        timeoutMs <= MAX_TOOL_TIMEOUT_MS
      )
    )
      throw pluginError('INVALID_ARGS', `工具 ${name} 的 timeoutMs 不合法`);
    return {
      pluginId,
      name,
      description: input.description,
      parameters: input.parameters,
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    };
  }

  private parseCommand(
    pluginId: string,
    manifest: ExtensionPluginManifest,
    input: Record<string, unknown>,
    used: number,
    checkStore: boolean
  ): DynamicCommand {
    const name = input.name;
    if (typeof name !== 'string' || !LOCAL_ID.test(name))
      throw pluginError('INVALID_ARGS', `命令 id 不合法：${String(name)}`);
    if (manifest.contributes.commands.some((command) => command.id === name))
      throw pluginError('INVALID_ARGS', `命令 ${name} 已在清单里`);
    if (
      checkStore &&
      this.commands.some((command) => command.pluginId === pluginId && command.id === name)
    )
      throw pluginError('INVALID_ARGS', `命令 ${name} 已注册`);
    if (used >= manifest.contributes.dynamic.commands)
      throw pluginError('QUOTA', '动态命令已达上限');
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 60)
      throw pluginError('INVALID_ARGS', `命令 ${name} 的 title 不合法`);
    return { pluginId, id: name, title: input.title };
  }
}
