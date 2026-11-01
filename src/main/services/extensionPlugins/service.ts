import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { grantExpands, grantOf } from '@shared/extensionPlugins/grant';
import { pluginManifestProbeUrl } from '@shared/extensionPlugins/installUrl';
import {
  type ExtensionPluginManifest,
  isNewerPluginVersion,
  isPluginRelativePath,
  type PluginPresetContrib,
  parseExtensionPluginManifest,
} from '@shared/extensionPlugins/manifest';
import { parsePluginPresetId, pluginPresetId } from '@shared/extensionPlugins/preset';
import type { PluginCallMethod, PluginToolResult } from '@shared/extensionPlugins/protocol';
import { parsePluginToolName, pluginToolName } from '@shared/extensionPlugins/toolName';
import type {
  ExtensionPluginConfigField,
  ExtensionPluginInstallPreview,
  ExtensionPluginSummary,
  PluginToolDescriptor,
} from '@shared/extensionPlugins/types';
import type { McpServerSpawnConfig } from '@shared/types/agent';
import type { WorkerForkOptions, WorkerProcess } from '../../platform/types';
import { type GateDeps, PluginHostGate } from './gate';
import {
  commitStaged,
  discardStaged,
  MANIFEST_FILE,
  type PluginInstallSource,
  pluginDataPath,
  pluginPackagePath,
  removePackage,
  type StagedPlugin,
  stagePlugin,
} from './install';
import { applyPluginAction, type PluginAction, type PluginRecord } from './lifecycle';
import { type PluginLogLevel, PluginProcess, pluginError } from './process';
import { readRegistry, writeRegistry } from './registry';

// biome-ignore lint/suspicious/noTemplateCurlyInString: 清单里的占位符字面量
const PLUGIN_ROOT_TOKEN = '${ENSO_PLUGIN_ROOT}';
const STAGE_TTL_MS = 10 * 60_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 3;
const TOOL_TIMEOUT_MS = 60_000;
const UI_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_TOOL_RESULT_BYTES = 1024 * 1024;
const MAX_UI_PAYLOAD_BYTES = 64 * 1024;
const UI_RATE_PER_SECOND = 10;
const BREAKER_FAILURES = 5;
const BREAKER_COOLDOWN_MS = 30_000;
const MAX_CONFIG_VALUE_CHARS = 4096;
const MAX_PRESET_TEXT_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const DEFAULT_LOG_TAIL_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 2000;
const UPDATE_CHECK_TIMEOUT_MS = 15_000;
const UPDATE_CHECK_FIRST_DELAY_MS = 60_000;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_PROBE_BYTES = 256 * 1024;

export interface ExtensionPluginServiceOptions {
  root: string;
  hostVersion: string;
  hostPath: string;
  env: NodeJS.ProcessEnv;
  fork(modulePath: string, args: string[], options: WorkerForkOptions): WorkerProcess;
  gate: Omit<GateDeps, 'manifest' | 'config'>;
}

export type UiCallMethod = Exclude<PluginCallMethod, 'tool.execute'>;

/** 界面调用的超时：渲染方法可在清单里声明更长的超时，其余固定 */
export function uiCallTimeout(
  manifest: Pick<ExtensionPluginManifest, 'contributes'> & {
    contributes: Pick<ExtensionPluginManifest['contributes'], 'methods'>;
  },
  method: UiCallMethod,
  payload: Record<string, unknown>
): number {
  if (method === 'command.run') return COMMAND_TIMEOUT_MS;
  if (method !== 'renderer.call') return UI_TIMEOUT_MS;
  const declared = manifest.contributes.methods.find((m) => m.name === payload.method);
  return declared?.timeoutMs ?? UI_TIMEOUT_MS;
}

interface Loaded {
  dir: string;
  manifest: ExtensionPluginManifest;
}

const within = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export class ExtensionPluginService {
  readonly gate: PluginHostGate;
  private records: PluginRecord[];
  private readonly loaded = new Map<string, Loaded>();
  private readonly processes = new Map<string, PluginProcess>();
  private readonly staged = new Map<
    string,
    { staged: StagedPlugin; at: number; source: PluginInstallSource }
  >();
  private readonly crashes = new Map<string, number[]>();
  /** 进程内最近一条错误日志；崩溃停用时写进登记 */
  private readonly recentErrors = new Map<string, { at: number; message: string }>();
  private readonly uiCalls = new Map<
    string,
    { stamps: number[]; failures: number; openUntil: number }
  >();
  private readonly listeners = new Set<() => void>();
  /** 检查更新的结果，只在内存；装上不低于该版本的包后清掉 */
  private readonly updates = new Map<string, { version?: string; error?: string }>();
  private updateTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ExtensionPluginServiceOptions) {
    this.records = readRegistry(options.root).plugins;
    this.gate = new PluginHostGate({
      ...options.gate,
      manifest: (id) => this.enabledManifest(id),
      config: (id) => this.configValues(id),
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): ExtensionPluginSummary[] {
    return this.records.flatMap((record) => {
      const manifest = this.load(record.id, record.dir);
      if (!manifest) return [];
      const pending = record.pending ? this.load(record.id, record.pending.dir) : null;
      return [
        {
          id: record.id,
          name: manifest.name,
          version: record.version,
          description: manifest.description,
          state: record.state,
          permissions: manifest.permissions,
          tools: manifest.contributes.agentTools.map(({ name, description }) => ({
            name,
            description,
          })),
          commands: manifest.contributes.commands,
          views: manifest.contributes.views.map(({ id, title, entry }) => ({ id, title, entry })),
          triggers: manifest.contributes.triggers,
          hasRenderer: manifest.renderer !== undefined,
          ...(manifest.renderer ? { renderer: manifest.renderer } : {}),
          configurable: manifest.contributes.configuration.length > 0,
          presets: manifest.contributes.presets.map((preset) => ({
            id: pluginPresetId(record.id, preset.id),
            name: preset.name,
            skills: preset.skills.length,
            mcpServers: preset.mcpServers.length,
            instruction: preset.instruction !== undefined,
          })),
          ...(record.pending && pending
            ? { pendingVersion: record.pending.version, pendingPermissions: pending.permissions }
            : {}),
          ...lastErrorField(record.lastError ?? this.recentErrors.get(record.id)),
          ...(record.source ? { source: sourceView(record.source) } : {}),
          ...updateFields(this.updates.get(record.id)),
        },
      ];
    });
  }

  /** 已启用插件的清单；停用、崩溃、未安装都返回 null */
  enabledManifest(id: string): ExtensionPluginManifest | null {
    const record = this.records.find((r) => r.id === id);
    return record?.state === 'enabled' ? this.load(record.id, record.dir) : null;
  }

  async stage(source: PluginInstallSource) {
    this.sweepStaged();
    const result = await stagePlugin(this.options.root, source, this.options.hostVersion);
    if (!result.ok) return result;
    const { staged } = result;
    this.staged.set(staged.token, { staged, at: Date.now(), source });
    const m = staged.manifest;
    const grant = grantOf(m);
    const existing = this.records.find((r) => r.id === m.id);
    const preview: ExtensionPluginInstallPreview = {
      token: staged.token,
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      permissions: m.permissions,
      fsRead: m.fs.read,
      fsWrite: m.fs.write,
      netDomains: m.net.domains,
      mcpServers: grant.mcp,
      mcpTools: m.mcp.tools,
      tools: m.contributes.agentTools.map(({ name, description }) => ({ name, description })),
      hasRenderer: m.renderer !== undefined,
      warnings: [...staged.warnings, ...versionWarnings(m.version, existing?.version)],
      ...(existing ? { existingVersion: existing.version } : {}),
      expands: existing ? grantExpands(existing.grant, grant) : true,
    };
    return { ok: true as const, preview };
  }

  /** 从记录的安装来源重新暂存；之后和普通更新一样确认、按授权是否扩大分流 */
  async restage(id: string) {
    const source = this.records.find((r) => r.id === id)?.source;
    if (!source) return { ok: false as const, error: '没有记录安装来源，请重新选择插件' };
    const result = await this.stage(source);
    if (result.ok && result.preview.id !== id) {
      this.discard(result.preview.token);
      return { ok: false as const, error: `来源里的插件已经不是 ${id}` };
    }
    return result;
  }

  discard(token: string): void {
    const entry = this.staged.get(token);
    if (!entry) return;
    this.staged.delete(token);
    discardStaged(this.options.root, entry.staged);
  }

  /** 用户同意后落盘；带 main 的插件先试加载，失败不留文件 */
  async commit(token: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const entry = this.staged.get(token);
    if (!entry) return { ok: false, error: '安装已过期，请重新选择插件' };
    this.staged.delete(token);
    const { manifest } = entry.staged;
    const { source } = entry;
    const dir = commitStaged(this.options.root, entry.staged);
    const trial = await this.trialLoad(manifest, dir);
    if (!trial.ok) {
      removePackage(this.options.root, manifest.id, dir);
      if (!this.records.some((r) => r.id === manifest.id)) {
        rmSync(join(this.options.root, 'packages', manifest.id), { recursive: true, force: true });
        rmSync(pluginDataPath(this.options.root, manifest.id), { recursive: true, force: true });
      }
      return trial;
    }
    const grant = grantOf(manifest);
    const existing = this.records.find((r) => r.id === manifest.id);
    if (!existing) {
      this.records.push({
        id: manifest.id,
        version: manifest.version,
        dir,
        state: 'disabled',
        grant,
        installedAt: Date.now(),
        source,
      });
    } else {
      const stalePending = existing.pending?.dir;
      const expands = grantExpands(existing.grant, grant);
      const oldDir = existing.dir;
      this.apply(existing.id, { type: 'update', version: manifest.version, dir, grant, expands });
      this.setSource(existing.id, source);
      if (stalePending) removePackage(this.options.root, existing.id, stalePending);
      const available = this.updates.get(existing.id)?.version;
      if (available && !isNewerPluginVersion(available, manifest.version))
        this.updates.delete(existing.id);
      if (!expands) {
        this.stopProcess(existing.id);
        removePackage(this.options.root, existing.id, oldDir);
      }
    }
    this.persist();
    return { ok: true };
  }

  setEnabled(id: string, enabled: boolean): { ok: boolean; error?: string } {
    if (!enabled) this.stopProcess(id);
    else this.recentErrors.delete(id);
    return this.applyAndPersist(id, { type: enabled ? 'enable' : 'disable' });
  }

  approvePending(id: string) {
    const oldDir = this.records.find((r) => r.id === id)?.dir;
    const result = this.applyAndPersist(id, { type: 'approve-pending' });
    if (result.ok && oldDir) {
      this.stopProcess(id);
      removePackage(this.options.root, id, oldDir);
    }
    return result;
  }

  rejectPending(id: string) {
    const pendingDir = this.records.find((r) => r.id === id)?.pending?.dir;
    const result = this.applyAndPersist(id, { type: 'reject-pending' });
    if (result.ok && pendingDir) removePackage(this.options.root, id, pendingDir);
    return result;
  }

  /** 拒绝新调用 → 取消挂起调用 → 停进程 → 删副本与数据目录 */
  async uninstall(id: string): Promise<{ ok: boolean; error?: string }> {
    const record = this.records.find((r) => r.id === id);
    if (!record) return { ok: false, error: '插件未安装' };
    this.records = this.records.filter((r) => r.id !== id);
    this.persist();
    this.stopProcess(id);
    rmSync(join(this.options.root, 'packages', id), { recursive: true, force: true });
    rmSync(pluginDataPath(this.options.root, id), { recursive: true, force: true });
    rmSync(this.configPath(id), { force: true });
    rmSync(this.logPath(id), { force: true });
    rmSync(`${this.logPath(id)}.1`, { force: true });
    this.recentErrors.delete(id);
    for (const key of this.loaded.keys()) if (key.startsWith(`${id}/`)) this.loaded.delete(key);
    return { ok: true };
  }

  /** 插件配置值（含密钥），只给插件进程 */
  configValues(id: string): Record<string, string> {
    const manifest = this.installedManifest(id);
    if (!manifest) return {};
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.configPath(id), 'utf8'));
    } catch {
      return {};
    }
    const out: Record<string, string> = {};
    if (typeof raw !== 'object' || raw === null) return out;
    for (const field of manifest.contributes.configuration) {
      const value = (raw as Record<string, unknown>)[field.key];
      if (typeof value === 'string') out[field.key] = value;
    }
    return out;
  }

  /** 给设置界面看的配置：密钥只报告是否已设置 */
  configView(
    id: string
  ): { ok: true; fields: ExtensionPluginConfigField[] } | { ok: false; error: string } {
    const manifest = this.installedManifest(id);
    if (!manifest) return { ok: false, error: '插件未安装' };
    const values = this.configValues(id);
    return {
      ok: true,
      fields: manifest.contributes.configuration.map((f) => {
        const value = values[f.key];
        return {
          ...f,
          set: value !== undefined,
          ...(!f.secret && value !== undefined ? { value } : {}),
        };
      }),
    };
  }

  /** 省略的键不变，null 清除；只接受清单声明的键 */
  setConfig(id: string, patch: Record<string, string | null>): { ok: boolean; error?: string } {
    const manifest = this.installedManifest(id);
    if (!manifest) return { ok: false, error: '插件未安装' };
    const keys = new Set(manifest.contributes.configuration.map((f) => f.key));
    const next = this.configValues(id);
    for (const [key, value] of Object.entries(patch)) {
      if (!keys.has(key)) return { ok: false, error: `未知配置项 ${key}` };
      if (value === null) delete next[key];
      else if (typeof value !== 'string' || value.length > MAX_CONFIG_VALUE_CHARS)
        return { ok: false, error: `配置项 ${key} 不合法或过长` };
      else next[key] = value;
    }
    const target = this.configPath(id);
    mkdirSync(join(this.options.root, 'config'), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, target);
    for (const listener of this.listeners) listener();
    return { ok: true };
  }

  toolsForSpawn(): PluginToolDescriptor[] {
    return this.enabled().flatMap(({ id, manifest }) =>
      manifest.contributes.agentTools.map((tool) => ({
        name: pluginToolName(id, tool.name),
        description: tool.description,
        parameters: tool.parameters,
        pluginId: id,
      }))
    );
  }

  skillPathsForSpawn(activePresetId?: string): string[] {
    return this.enabled().flatMap(({ id, dir, manifest }) => {
      const root = pluginPackagePath(this.options.root, id, dir);
      return this.contributedSkills(id, manifest, activePresetId).map((rel) => resolve(root, rel));
    });
  }

  /** 服务名加 `plugin-<id>-` 前缀；`${ENSO_PLUGIN_ROOT}` 展开为安装目录，env 只含清单字面量 */
  mcpServersForSpawn(activePresetId?: string): McpServerSpawnConfig[] {
    return this.enabled().flatMap(({ id, dir, manifest }) => {
      const pluginRoot = pluginPackagePath(this.options.root, id, dir);
      const expand = (value: string) => value.replaceAll(PLUGIN_ROOT_TOKEN, pluginRoot);
      const names = this.contributedMcp(id, manifest, activePresetId);
      return manifest.contributes.mcpServers
        .filter((server) => names.has(server.name))
        .map((s) => ({
          name: `plugin-${id.replaceAll('.', '-')}-${s.name}`,
          description: `${manifest.name} 插件`,
          transport: 'stdio' as const,
          command: expand(s.command),
          args: s.args.map(expand),
          env: {
            ...Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, expand(v)])),
            ENSO_PLUGIN_ROOT: pluginRoot,
          },
        }));
    });
  }

  /**
   * 解析会话选中的插件预设。不是插件预设 id 时返回 undefined。
   * 插件未启用、预设不存在或正文读不出时失败，不回落成全局预设。
   */
  presetForSpawn(presetId?: string):
    | {
        ok: true;
        instruction?: { path: string; content: string };
        systemPrompt?: string;
        systemPromptAppend?: string;
        systemPromptBoost?: string;
        refusalRetryPrompt?: string;
      }
    | { ok: false; error: string }
    | undefined {
    if (!presetId) return undefined;
    const parsed = parsePluginPresetId(presetId);
    if (!parsed) return undefined;
    const loaded = this.enabled().find((entry) => entry.id === parsed.pluginId);
    const preset = loaded?.manifest.contributes.presets.find((item) => item.id === parsed.localId);
    if (!loaded || !preset) return { ok: false, error: '插件预设不可用，请重新选择或恢复默认。' };
    const root = pluginPackagePath(this.options.root, loaded.id, loaded.dir);
    const read = (rel?: string): { ok: true; content: string } | { ok: false } | undefined => {
      if (!rel) return undefined;
      return readPluginText(root, rel);
    };
    const instruction = read(preset.instruction);
    const role = read(preset.systemPrompt);
    const tail = read(preset.systemPromptTail);
    const boost = read(preset.boostPrompt);
    const retry = read(preset.refusalRetryPrompt);
    if (
      instruction?.ok === false ||
      role?.ok === false ||
      tail?.ok === false ||
      boost?.ok === false ||
      retry?.ok === false
    )
      return { ok: false, error: '插件预设的正文读取失败，请重新安装插件。' };
    return {
      ok: true,
      ...(instruction?.ok
        ? { instruction: { path: join(root, preset.instruction!), content: instruction.content } }
        : {}),
      ...(role?.ok ? { systemPrompt: role.content } : {}),
      ...(tail?.ok ? { systemPromptAppend: tail.content } : {}),
      ...(boost?.ok ? { systemPromptBoost: boost.content } : {}),
      ...(preset.refusalRetry === true && retry?.ok ? { refusalRetryPrompt: retry.content } : {}),
    };
  }

  private contributedSkills(
    pluginId: string,
    manifest: ExtensionPluginManifest,
    activePresetId?: string
  ): string[] {
    const { scoped, selected } = presetSelection(
      manifest,
      pluginId,
      activePresetId,
      (preset) => preset.skills
    );
    return manifest.contributes.skills.filter((rel) => !scoped.has(rel) || selected.has(rel));
  }

  private contributedMcp(
    pluginId: string,
    manifest: ExtensionPluginManifest,
    activePresetId?: string
  ): Set<string> {
    const { scoped, selected } = presetSelection(
      manifest,
      pluginId,
      activePresetId,
      (preset) => preset.mcpServers
    );
    return new Set(
      manifest.contributes.mcpServers
        .map((server) => server.name)
        .filter((name) => !scoped.has(name) || selected.has(name))
    );
  }

  async callTool(input: {
    toolName: string;
    args: unknown;
    sessionId: string;
    projectRoot: string | null;
    signal?: AbortSignal;
  }): Promise<PluginToolResult> {
    const parsed = parsePluginToolName(input.toolName);
    if (!parsed) throw pluginError('NOT_FOUND', `不是插件工具：${input.toolName}`);
    const manifest = this.enabledManifest(parsed.pluginId);
    if (!manifest) throw pluginError('PLUGIN_DISABLED', '插件未启用');
    if (!manifest.contributes.agentTools.some((t) => t.name === parsed.toolName))
      throw pluginError('NOT_FOUND', `插件没有声明工具 ${parsed.toolName}`);
    const value = await this.invoke(
      parsed.pluginId,
      'tool.execute',
      { name: parsed.toolName, args: input.args },
      {
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        gesture: false,
        timeoutMs: TOOL_TIMEOUT_MS,
      },
      input.signal
    );
    const result = value as PluginToolResult;
    if (!result || typeof result.content !== 'string')
      throw pluginError('BAD_RESULT', '插件工具返回值不合法');
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_TOOL_RESULT_BYTES)
      throw pluginError('TOO_LARGE', '插件工具结果超过 1MB');
    return result;
  }

  /** 界面发起的调用（命令、挂件、侧栏页面、补全）：算用户手势 */
  async callUi(input: {
    pluginId: string;
    method: UiCallMethod;
    payload: Record<string, unknown>;
    sessionId: string | null;
    projectRoot: string | null;
    /** 发起调用的窗口 webContents id，草稿请求只回到这里 */
    origin?: number | null;
  }): Promise<unknown> {
    const manifest = this.enabledManifest(input.pluginId);
    if (!manifest) throw pluginError('PLUGIN_DISABLED', '插件未启用');
    const declared =
      input.method === 'command.run'
        ? manifest.contributes.commands.some((c) => c.id === input.payload.id)
        : input.method === 'renderer.call'
          ? manifest.permissions.includes('ui.slot') || manifest.permissions.includes('ui.view')
          : manifest.contributes.triggers.some((t) => t.name === input.payload.name);
    if (!declared) throw pluginError('NOT_DECLARED', '清单没有声明这项能力');
    if (Buffer.byteLength(JSON.stringify(input.payload), 'utf8') > MAX_UI_PAYLOAD_BYTES)
      throw pluginError('TOO_LARGE', '参数超过 64KB');
    this.admitUiCall(input.pluginId);
    try {
      const value = await this.invoke(input.pluginId, input.method, input.payload, {
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        gesture: true,
        origin: input.origin ?? null,
        timeoutMs: uiCallTimeout(manifest, input.method, input.payload),
      });
      if (Buffer.byteLength(JSON.stringify(value ?? null), 'utf8') > MAX_UI_PAYLOAD_BYTES)
        throw pluginError('TOO_LARGE', '返回值超过 64KB');
      this.settleUiCall(input.pluginId, true);
      return value;
    } catch (error) {
      this.settleUiCall(input.pluginId, false);
      throw error;
    }
  }

  /** 渲染资源（ui.js / 侧栏页面）在安装目录内的真实路径；未启用或越界返回 null */
  assetPath(pluginId: string, rel: string): string | null {
    const record = this.records.find((r) => r.id === pluginId);
    if (record?.state !== 'enabled' || !isPluginRelativePath(rel) || rel === '.') return null;
    const base = pluginPackagePath(this.options.root, record.id, record.dir);
    try {
      const real = realpathSync(resolve(base, rel));
      return within(realpathSync(base), real) ? real : null;
    } catch {
      return null;
    }
  }

  /** 非预期退出或加载失败计一次；窗口内达到上限即停用并持久化 */
  recordCrash(id: string): void {
    const now = Date.now();
    const recent = (this.crashes.get(id) ?? []).filter((t) => now - t < CRASH_WINDOW_MS);
    recent.push(now);
    this.crashes.set(id, recent);
    if (recent.length < CRASH_LIMIT) return;
    this.crashes.delete(id);
    this.stopProcess(id);
    const result = this.apply(id, { type: 'crash' });
    if (!result.ok) return;
    const index = this.records.findIndex((r) => r.id === id);
    const record = this.records[index];
    if (record)
      this.records[index] = {
        ...record,
        lastError: this.recentErrors.get(id) ?? { at: now, message: '插件进程反复异常退出' },
      };
    this.persist();
  }

  /** 插件进程的输出与异常，落在 Main 私有目录；超过 1MB 轮转一次 */
  appendLog(id: string, level: PluginLogLevel, message: string): void {
    const path = this.logPath(id);
    try {
      mkdirSync(join(this.options.root, 'logs'), { recursive: true });
      try {
        if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
      } catch {}
      appendFileSync(path, `${new Date().toISOString()} [${level}] ${message}\n`, { mode: 0o600 });
    } catch {}
    if (level === 'error') this.recordError(id, message);
  }

  recordError(id: string, message: string): void {
    this.recentErrors.set(id, { at: Date.now(), message: message.slice(0, MAX_ERROR_CHARS) });
  }

  /** 日志末尾；没有日志返回空串 */
  logs(id: string, maxBytes = DEFAULT_LOG_TAIL_BYTES): string {
    let fd: number | null = null;
    try {
      const size = statSync(this.logPath(id)).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      fd = openSync(this.logPath(id), 'r');
      readSync(fd, buffer, 0, length, size - length);
      const text = buffer.toString('utf8');
      return length < size ? text.slice(text.indexOf('\n') + 1) : text;
    } catch {
      return '';
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  /** 启动后稍等检查一次，之后每天一次；只查已启用的插件 */
  startUpdateChecks(): void {
    if (this.updateTimer) return;
    const run = (delay: number) => {
      this.updateTimer = setTimeout(() => {
        void this.checkUpdates({ enabledOnly: true }).finally(() => {
          if (this.updateTimer) run(UPDATE_CHECK_INTERVAL_MS);
        });
      }, delay);
      this.updateTimer.unref?.();
    };
    run(UPDATE_CHECK_FIRST_DELAY_MS);
  }

  /** 只拉 GitHub 来源里的清单比较版本，不下载整包、不自动安装 */
  async checkUpdates(options: { enabledOnly?: boolean } = {}) {
    const targets = this.records.flatMap((record) => {
      if (options.enabledOnly && record.state !== 'enabled') return [];
      if (record.source?.kind !== 'url') return [];
      const probe = pluginManifestProbeUrl(new URL(record.source.url));
      return probe ? [{ record, probe }] : [];
    });
    const results = await Promise.all(
      targets.map(async ({ record, probe }) => {
        try {
          const version = await this.probeVersion(record.id, probe);
          const update = isNewerPluginVersion(version, record.version) ? { version } : {};
          this.updates.set(record.id, update);
          return update.version ? 'available' : 'current';
        } catch (error) {
          this.updates.set(record.id, {
            error: error instanceof Error ? error.message : '检查更新失败',
          });
          return 'failed';
        }
      })
    );
    if (targets.length > 0) for (const listener of this.listeners) listener();
    return {
      checked: targets.length,
      available: results.filter((r) => r === 'available').length,
      failed: results.filter((r) => r === 'failed').length,
    };
  }

  private async probeVersion(id: string, probe: URL): Promise<string> {
    let text: string;
    try {
      const response = await this.options.gate.fetch(probe.href, {
        signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`);
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('检查更新失败')) throw error;
      throw new Error('无法连接更新来源');
    }
    if (text.length > MAX_PROBE_BYTES) throw new Error('远端清单过大');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error('远端清单不是合法的 JSON');
    }
    const parsed = parseExtensionPluginManifest(raw, this.options.hostVersion);
    if (!parsed.ok) throw new Error(`远端清单不可用：${parsed.errors[0] ?? ''}`);
    if (parsed.manifest.id !== id) throw new Error(`来源里的插件已经不是 ${id}`);
    return parsed.manifest.version;
  }

  dispose(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = null;
    for (const id of [...this.processes.keys()]) this.stopProcess(id);
  }

  private async invoke(
    pluginId: string,
    method: PluginCallMethod,
    payload: unknown,
    ctx: {
      sessionId: string | null;
      projectRoot: string | null;
      gesture: boolean;
      origin?: number | null;
      timeoutMs: number;
    },
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) throw pluginError('ABORTED', '调用已取消');
    const proc = this.processFor(pluginId);
    const invocationId = this.gate.invocations.create({
      pluginId,
      sessionId: ctx.sessionId,
      projectRoot: ctx.projectRoot,
      gesture: ctx.gesture,
      origin: ctx.origin ?? null,
    });
    const onAbort = () => {
      this.gate.invocations.cancel(invocationId);
      proc.cancel(invocationId);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await proc.call(method, payload, {
        invocationId,
        sessionId: ctx.sessionId,
        projectRoot: ctx.projectRoot,
        timeoutMs: ctx.timeoutMs,
      });
    } catch (error) {
      // 超时或失败后中止这次调用里仍在进行的宿主请求（如 MCP 调用）
      this.gate.invocations.cancel(invocationId);
      if ((error as { code?: string }).code === 'PLUGIN_INIT_FAILED') this.recordCrash(pluginId);
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.gate.invocations.finish(invocationId);
    }
  }

  private processFor(pluginId: string): PluginProcess {
    const existing = this.processes.get(pluginId);
    if (existing) return existing;
    const record = this.records.find((r) => r.id === pluginId);
    const manifest = record ? this.load(record.id, record.dir) : null;
    if (!record || !manifest?.main) throw pluginError('NOT_FOUND', '插件没有 main');
    const proc = this.createProcess(manifest, record.dir, (unexpected) => {
      if (unexpected) this.recordCrash(pluginId);
    });
    this.processes.set(pluginId, proc);
    return proc;
  }

  private createProcess(
    manifest: ExtensionPluginManifest,
    dir: string,
    onExit: (unexpected: boolean) => void
  ) {
    const dataDir = pluginDataPath(this.options.root, manifest.id);
    mkdirSync(dataDir, { recursive: true });
    return new PluginProcess({
      fork: this.options.fork,
      hostPath: this.options.hostPath,
      env: { ...this.options.env, ENSO_PLUGIN_DATA: dataDir },
      init: {
        pluginId: manifest.id,
        pluginRoot: pluginPackagePath(this.options.root, manifest.id, dir),
        main: manifest.main ?? '',
        dataDir,
      },
      handleHostCall: (api, args, invocationId) =>
        this.gate.handle(manifest.id, api, args, invocationId),
      onExit: ({ unexpected }) => {
        if (unexpected) this.appendLog(manifest.id, 'warn', '插件进程意外退出');
        onExit(unexpected);
      },
      onLog: (level, message) => this.appendLog(manifest.id, level, message),
    });
  }

  private async trialLoad(manifest: ExtensionPluginManifest, dir: string) {
    if (!manifest.main) return { ok: true as const };
    const proc = this.createProcess(manifest, dir, () => {});
    try {
      await proc.ready();
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        error: `插件加载失败：${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      proc.stop();
    }
  }

  private stopProcess(id: string): void {
    this.gate.invocations.cancelPlugin(id);
    this.processes.get(id)?.stop();
    this.processes.delete(id);
  }

  private enabled(): (Loaded & { id: string })[] {
    return this.records.flatMap((r) => {
      if (r.state !== 'enabled') return [];
      const manifest = this.load(r.id, r.dir);
      return manifest ? [{ id: r.id, dir: r.dir, manifest }] : [];
    });
  }

  /** 已安装（不论启停）的当前版本清单 */
  private installedManifest(id: string): ExtensionPluginManifest | null {
    const record = this.records.find((r) => r.id === id);
    return record ? this.load(record.id, record.dir) : null;
  }

  private configPath(id: string): string {
    return join(this.options.root, 'config', `${id}.json`);
  }

  private setSource(id: string, source: PluginInstallSource): void {
    const index = this.records.findIndex((r) => r.id === id);
    const record = this.records[index];
    if (record) this.records[index] = { ...record, source };
  }

  private logPath(id: string): string {
    return join(this.options.root, 'logs', `${id}.log`);
  }

  private load(id: string, dir: string): ExtensionPluginManifest | null {
    const key = `${id}/${dir}`;
    const cached = this.loaded.get(key);
    if (cached) return cached.manifest;
    try {
      const raw = JSON.parse(
        readFileSync(join(pluginPackagePath(this.options.root, id, dir), MANIFEST_FILE), 'utf8')
      );
      const parsed = parseExtensionPluginManifest(raw, this.options.hostVersion);
      if (!parsed.ok || parsed.manifest.id !== id) return null;
      this.loaded.set(key, { dir, manifest: parsed.manifest });
      return parsed.manifest;
    } catch {
      return null;
    }
  }

  private apply(id: string, action: PluginAction): { ok: boolean; error?: string } {
    const index = this.records.findIndex((r) => r.id === id);
    const record = this.records[index];
    if (!record) return { ok: false, error: '插件未安装' };
    const next = applyPluginAction(record, action);
    if ('error' in next) return { ok: false, error: next.error };
    this.records[index] = next;
    return { ok: true };
  }

  private applyAndPersist(id: string, action: PluginAction) {
    const result = this.apply(id, action);
    if (result.ok) this.persist();
    return result;
  }

  private persist(): void {
    writeRegistry(this.options.root, { version: 1, plugins: this.records });
    for (const listener of this.listeners) listener();
  }

  private sweepStaged(): void {
    const now = Date.now();
    for (const [token, entry] of this.staged)
      if (now - entry.at > STAGE_TTL_MS) this.discard(token);
  }

  private admitUiCall(pluginId: string): void {
    const now = Date.now();
    const state = this.uiCalls.get(pluginId) ?? { stamps: [], failures: 0, openUntil: 0 };
    this.uiCalls.set(pluginId, state);
    if (now < state.openUntil) throw pluginError('CIRCUIT_OPEN', '插件连续失败，稍后再试');
    state.stamps = state.stamps.filter((t) => now - t < 1000);
    if (state.stamps.length >= UI_RATE_PER_SECOND)
      throw pluginError('RATE_LIMITED', '调用过于频繁');
    state.stamps.push(now);
  }

  private settleUiCall(pluginId: string, ok: boolean): void {
    const state = this.uiCalls.get(pluginId);
    if (!state) return;
    if (ok) state.failures = 0;
    else if (++state.failures >= BREAKER_FAILURES) {
      state.failures = 0;
      state.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    }
  }
}

/** 本地路径不下发给界面，只给类型；链接本来就是用户填的，可以显示 */
const sourceView = (source: PluginInstallSource): ExtensionPluginSummary['source'] =>
  source.kind === 'url' ? { kind: 'url', url: source.url } : { kind: source.kind };

const updateFields = (update: { version?: string; error?: string } | undefined) => ({
  ...(update?.version ? { availableVersion: update.version } : {}),
  ...(update?.error ? { updateCheckError: update.error } : {}),
});

function versionWarnings(next: string, current: string | undefined): string[] {
  if (current === undefined || isNewerPluginVersion(next, current)) return [];
  if (next.trim() === current.trim()) return [`版本号没有变化（${current}），确认后会覆盖当前安装`];
  return [`版本 ${next} 低于已安装的 ${current}，确认后会降级`];
}

const lastErrorField = (lastError: { at: number; message: string } | undefined) =>
  lastError ? { lastError: { at: lastError.at, message: lastError.message } } : {};

function presetSelection(
  manifest: ExtensionPluginManifest,
  pluginId: string,
  activePresetId: string | undefined,
  pick: (preset: PluginPresetContrib) => readonly string[]
): { scoped: Set<string>; selected: Set<string> } {
  const parsed = activePresetId ? parsePluginPresetId(activePresetId) : undefined;
  const active =
    parsed?.pluginId === pluginId
      ? manifest.contributes.presets.find((preset) => preset.id === parsed.localId)
      : undefined;
  return {
    scoped: new Set(manifest.contributes.presets.flatMap((preset) => pick(preset))),
    selected: new Set(active ? pick(active) : []),
  };
}

function readPluginText(root: string, rel: string): { ok: true; content: string } | { ok: false } {
  if (!isPluginRelativePath(rel) || rel === '.') return { ok: false };
  const path = resolve(root, rel);
  const fromRoot = relative(root, path);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) return { ok: false };
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_PRESET_TEXT_BYTES) return { ok: false };
    const content = readFileSync(path, 'utf8');
    if (!content.trim()) return { ok: false };
    return { ok: true, content };
  } catch {
    return { ok: false };
  }
}
