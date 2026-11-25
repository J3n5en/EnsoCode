import type { DefaultModelRef } from '../defaultModel';
import type { ThinkingLevel } from './agent';

/** 扁平项目组（只挂项目，不挂会话） */
export interface ProjectGroup {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  order: number;
  /** 本组新对话默认模型；缺省则跟全局 */
  defaultModel?: DefaultModelRef;
  defaultReasoningEnabled?: boolean;
  defaultThinkingLevel?: ThinkingLevel;
}

/** 项目：本地目录或 ssh 远程目录的引用，作为会话的工作目录 */
export interface Project {
  id: string;
  name: string;
  path: string;
  /** 用户自定义别名；非空时优先于 name 展示，name/path 仍参与搜索 */
  alias?: string;
  /** 缺省 local;ssh 项目的工具调用全部在远端执行 */
  kind?: 'local' | 'ssh' | 'scratch' | 'secretary';
  /** kind='ssh' 时的 ssh 目标(user@host 或 ssh config 别名) */
  sshHost?: string;
  sshConnectionId?: string;
  sshConnectionName?: string;
  /** 所属项目组；缺省或指向已删组 = 未分组 */
  groupId?: string;
  /** 本项目新对话默认模型；缺省则跟分组/全局 */
  defaultModel?: DefaultModelRef;
  defaultReasoningEnabled?: boolean;
  defaultThinkingLevel?: ThinkingLevel;
  /**
   * 本项目关闭的内置工具。缺省跟随全局；一旦存了数组（含空 = 全开）则覆盖全局，
   * 新建或冷恢复会话生效。
   */
  disabledBuiltinTools?: string[];
  /** 本项目允许统一 subagent 工具创建的 Agent 模式；缺省跟随全局。 */
  subagentAllowedModes?: ('task' | 'coworker')[];
  /** 用户确认过的项目代码来源（.pi/extensions、项目包等）；出现新来源时须重新确认 */
  trustedProjectCode?: string[];
}

/** 从 settings.projects 取出某项目已信任的代码来源；缺项目或坏配置返回空。 */
export function projectTrustedCode(projects: unknown, projectId: string | undefined): string[] {
  if (!projectId || !Array.isArray(projects)) return [];
  const record = projects.find(
    (entry): entry is { id: unknown; trustedProjectCode?: unknown } =>
      Boolean(entry) && typeof entry === 'object' && (entry as { id?: unknown }).id === projectId
  );
  const list = record?.trustedProjectCode;
  return Array.isArray(list)
    ? list.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

/** 从本地编辑器 / 编程应用读到的最近打开目录 */
export interface RecentProject {
  path: string;
  displayPath: string;
  sourceName: string;
}

/** 宿主机目录浏览结果：parent 为 null 表示已到根 */
export type HostDirListing =
  | { ok: true; path: string; parent: string | null; dirs: string[] }
  | { ok: false; error: string };

/** 本机目录搜索：host 是机器名，displayPath 在家目录下写成 ~/... */
export type HostDirSearchResult =
  | { ok: true; host: string; results: { path: string; displayPath: string }[] }
  | { ok: false; error: string };

/** 本机已安装、可用于打开项目目录的编辑器 / 终端（id 是注册表标识，不是路径） */
export interface OpenInApp {
  id: string;
  name: string;
  kind: 'editor' | 'terminal';
  /** PNG data URL */
  icon?: string;
}
