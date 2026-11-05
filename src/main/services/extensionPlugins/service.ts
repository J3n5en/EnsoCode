import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  applyInterceptResult,
  BEFORE_COMPACT_TIMEOUT_MS,
  CHILD_INTERCEPT_TIMEOUT_MS,
  CHILD_INTERCEPT_TOTAL_TIMEOUT_MS,
  failClosedResult,
  INTERCEPT_TIMEOUT_MS,
  INTERCEPT_TOTAL_TIMEOUT_MS,
  type InterceptPayload,
  type InterceptResult,
  initialInterceptState,
  isChildInterceptEvent,
  isHostPluginEvent,
  OBSERVE_TIMEOUT_MS,
  type PluginEventName,
  type PluginInterceptEvent,
} from '@shared/extensionPlugins/events';
import { grantExpands, grantOf } from '@shared/extensionPlugins/grant';
import { pluginManifestProbeUrl } from '@shared/extensionPlugins/installUrl';
import {
  type ExtensionPluginManifest,
  isNewerPluginVersion,
  isPluginRelativePath,
  type PluginConfigContrib,
  type PluginPresetContrib,
  parseExtensionPluginManifest,
} from '@shared/extensionPlugins/manifest';
import { parsePluginPresetId, pluginPresetId } from '@shared/extensionPlugins/preset';
import {
  PLUGIN_PROGRESS_MAX_CHARS,
  type PluginAgentSource,
  type PluginArtifactInfo,
  type PluginCallMethod,
  type PluginHostCapabilities,
  type PluginInjectImage,
  type PluginToolResult,
} from '@shared/extensionPlugins/protocol';
import { parsePluginToolName, pluginToolName } from '@shared/extensionPlugins/toolName';
import type {
  ExtensionPluginConfigField,
  ExtensionPluginInstallPreview,
  ExtensionPluginMarketList,
  ExtensionPluginSummary,
  PluginEventPlan,
  PluginToolDescriptor,
  RegistryNotice,
} from '@shared/extensionPlugins/types';
import type { McpServerSpawnConfig } from '@shared/types/agent';
import type { WorkerForkOptions, WorkerProcess } from '../../platform/types';
import type {
  NativeAgentTypeSource,
  NativePluginAgentDef,
  PluginAgentTypeDrop,
} from '../pluginRuntime';
import { ArtifactStore } from './artifacts';
import { DynamicContribs } from './dynamic';
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
import { DEFAULT_LOG_TAIL_BYTES, PluginLogger } from './log';
import { marketIconUrl, type PluginMarket } from './market';
import { type PluginLogLevel, PluginProcess, pluginError } from './process';
import {
  preserveUnreadableRegistry,
  REGISTRY_VERSION,
  readRegistry,
  writeRegistry,
} from './registry';
import { ViewStateStore } from './viewState';

// biome-ignore lint/suspicious/noTemplateCurlyInString: 清单里的占位符字面量
const PLUGIN_ROOT_TOKEN = '${ENSO_PLUGIN_ROOT}';
const STAGE_TTL_MS = 10 * 60_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 3;
const TOOL_TIMEOUT_MS = 60_000;
const UI_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 60_000;
const SCHEDULE_TIMEOUT_MS = 60_000;
const PREPARE_TIMEOUT_MS = 5_000;
const CHANGE_DEBOUNCE_MS = 150;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;

const INTERCEPT_BREAKER_FAILURES = 3;
const INTERCEPT_BREAKER_MS = 30_000;
/** 子会话的拦截单独熔断：它的预算更紧，失败不能让主会话的检查被跳过 */
const CHILD_BREAKER_PREFIX = 'child:';
const breakerLabel = (key: string): string =>
  key.startsWith(CHILD_BREAKER_PREFIX)
    ? `${key.slice(CHILD_BREAKER_PREFIX.length)}（子代理与 coworker）`
    : key;

class InterceptDeadlineError extends Error {
  constructor() {
    super('拦截总时长已用尽');
  }
}
const RESIDENT_LIMIT = 5;
const RESIDENT_RESTART_MS = 5_000;
const PROGRESS_INTERVAL_MS = 200;
const MAX_TOOL_RESULT_BYTES = 1024 * 1024;
const MAX_UI_PAYLOAD_BYTES = 64 * 1024;
const UI_RATE_PER_SECOND = 10;
const BREAKER_FAILURES = 5;
const BREAKER_COOLDOWN_MS = 30_000;
const MAX_CONFIG_VALUE_CHARS = 4096;
const MAX_PRESET_TEXT_BYTES = 256 * 1024;
const MAX_ERROR_CHARS = 2000;
const UPDATE_CHECK_TIMEOUT_MS = 15_000;
const UPDATE_CHECK_FIRST_DELAY_MS = 60_000;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_PROBE_BYTES = 256 * 1024;

export interface PluginSessionBridge {
  inject(
    sessionId: string,
    message: {
      pluginId: string;
      pluginName: string;
      text: string;
      images: PluginInjectImage[];
      deliverAs: 'steer' | 'followUp' | 'nextTurn';
      triggerTurn: boolean;
    }
  ): { ok: true } | { ok: false; error: string; notRunning?: boolean };
  abort(sessionId: string): { ok: true } | { ok: false; error: string };
}

export interface PluginToolOutcome {
  content: string;
  details?: unknown;
  artifacts: PluginArtifactInfo[];
}

type ConfigValue = string | number | boolean;

export interface ExtensionPluginServiceOptions {
  root: string;
  hostVersion: string;
  hostPath: string;
  env: NodeJS.ProcessEnv;
  /** 声明的环境变量从这里取；缺省不额外透传 */
  sourceEnv?: NodeJS.ProcessEnv;
  capabilities?: PluginHostCapabilities;
  sessionBridge?: () => PluginSessionBridge | null;
  fork(modulePath: string, args: string[], options: WorkerForkOptions): WorkerProcess;
  gate: Omit<GateDeps, 'manifest' | 'config'>;
  market?: PluginMarket;
  /** 拉起动态工具时单个插件的等待上限，测试可缩短 */
  prepareTimeoutMs?: number;
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

interface ObserveJob {
  sessionId: string;
  projectRoot: string | null;
  data: unknown;
  agent?: PluginAgentSource;
}

interface ObserveLane {
  running: boolean;
  queue: ObserveJob[];
}

/** 高频且可丢：进行中只保留最新一条。其余通知按顺序排队 */
const OBSERVE_COALESCE_EVENTS = new Set<PluginEventName>(['context_usage', 'tool_result']);
const OBSERVE_QUEUE_LIMIT = 32;

const within = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export class ExtensionPluginService {
  readonly gate: PluginHostGate;
  private records: PluginRecord[];
  private readonly loaded = new Map<string, Loaded | null>();
  private readonly textCache = new Map<string, { ok: true; content: string } | { ok: false }>();
  private readonly configCache = new Map<string, Record<string, ConfigValue>>();
  private readonly prepareFailed = new Set<string>();
  private readonly countedSpawns = new WeakSet<Promise<unknown>>();
  private readonly lastSpawn = new WeakMap<PluginProcess, Promise<unknown>>();
  private readonly idTails = new Map<string, Promise<void>>();
  private readonly observeLanes = new Map<string, ObserveLane>();
  private readonly processes = new Map<string, PluginProcess>();
  private readonly staged = new Map<
    string,
    { staged: StagedPlugin; at: number; source: PluginInstallSource }
  >();
  private readonly crashes = new Map<string, number[]>();
  /** 进程内最近一条错误日志；崩溃停用时写进登记 */
  private readonly recentErrors = new Map<string, { at: number; message: string }>();
  private readonly interceptFailures = new Map<string, { failures: number; openUntil: number }>();
  private readonly uiCalls = new Map<
    string,
    { stamps: number[]; failures: number; openUntil: number }
  >();
  private readonly listeners = new Set<() => void>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly logger: PluginLogger;
  /** 检查更新的结果，只在内存；装上不低于该版本的包后清掉 */
  private readonly updates = new Map<string, { version?: string; error?: string }>();
  private updateTimer: NodeJS.Timeout | null = null;
  private readonly artifacts: ArtifactStore;
  private readonly viewState: ViewStateStore;
  private readonly dynamic = new DynamicContribs();
  private readonly progressTaps = new Map<string, (text: string) => void>();
  private readonly gateManifests = new Map<string, ExtensionPluginManifest>();
  private readonly trialing = new Set<string>();
  /** 子代理类型的告警只记一次，避免每次取类型列表都写日志 */
  private readonly agentTypeWarned = new Set<string>();
  private readonly trialCounts = new Map<string, { tools: number; commands: number }>();
  private background = false;
  private disposed: Promise<void> | null = null;
  private isDisposed = false;
  private readonly starting = new Set<string>();
  private readonly residentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly restartGen = new Map<string, number>();
  private readonly scheduleRuns = new Map<
    string,
    {
      running: boolean;
      timer: ReturnType<typeof setInterval>;
      lastRunAt?: number;
      lastError?: string;
    }
  >();

  constructor(private readonly options: ExtensionPluginServiceOptions) {
    this.artifacts = new ArtifactStore(options.root);
    this.logger = new PluginLogger(options.root);
    this.viewState = new ViewStateStore(options.root);
    const registry = readRegistry(options.root);
    this.records = registry.plugins;
    this.gate = new PluginHostGate({
      ...options.gate,
      manifest: (id) => this.gateManifests.get(id) ?? this.enabledManifest(id),
      config: (id) => this.pluginConfig(id),
      progress: (invocationId, text) => this.progressTaps.get(invocationId)?.(text),
      writeArtifact: (pluginId, input) => this.artifacts.write(pluginId, input),
      inject: (pluginId, input) => this.inject(pluginId, input),
      abort: (pluginId, sessionId) => {
        const bridge = this.enabledManifest(pluginId) ? this.options.sessionBridge?.() : null;
        return bridge ? bridge.abort(sessionId) : { ok: false, error: '当前环境不能中止会话' };
      },
      crossSessionInject: (pluginId) =>
        this.records.find((r) => r.id === pluginId)?.crossSessionInject === true,
      callPlugin: (callerId, targetId, name, args, depth, caller) =>
        this.callExport(callerId, targetId, name, args, depth, caller),
      registerContrib: (pluginId, input) => this.registerContrib(pluginId, input),
      unregisterContrib: (pluginId, input) => this.unregisterContrib(pluginId, input),
      capabilities: () =>
        options.capabilities ?? {
          host: 'desktop',
          hostVersion: options.hostVersion,
          notify: true,
          mcp: true,
          clipboard: false,
          openExternal: false,
          composer: true,
        },
    });
    this.settleRegistry(registry.discarded, registry.unreadable);
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
          build: record.dir,
          description: manifest.description,
          ...(manifest.icon ? { icon: manifest.icon } : {}),
          state: record.state,
          permissions: manifest.permissions,
          tools: manifest.contributes.agentTools.map(({ name, description }) => ({
            name,
            description,
          })),
          commands: manifest.contributes.commands,
          views: manifest.contributes.views.map(({ id, title, entry }) => ({ id, title, entry })),
          // css 只在用户同意过样式能力时下发，渲染层据此决定读不读
          themes: manifest.contributes.themes.map(({ css, ...theme }) =>
            css !== undefined && record.grant.styles ? { ...theme, css } : theme
          ),
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
            ...(preset.model ? { model: preset.model } : {}),
          })),
          ...(this.dynamic.commandsFor(record.id).length > 0
            ? {
                dynamicCommands: this.dynamic
                  .commandsFor(record.id)
                  .map(({ id, title }) => ({ id, title })),
              }
            : {}),
          resident: manifest.resident,
          running: manifest.resident ? (this.processes.get(record.id)?.running ?? false) : false,
          schedules: manifest.contributes.schedules.map((schedule) => {
            const state = this.scheduleRuns.get(scheduleKey(record.id, schedule.id));
            return {
              id: schedule.id,
              intervalSeconds: schedule.intervalSeconds,
              ...(state?.lastRunAt !== undefined ? { lastRunAt: state.lastRunAt } : {}),
              ...(state?.lastError ? { lastError: state.lastError } : {}),
            };
          }),
          events: manifest.contributes.events.map(({ event, mode }) => ({ event, mode })),
          ...(this.openInterceptBreakers(record.id).length > 0
            ? { interceptBreakers: this.openInterceptBreakers(record.id) }
            : {}),
          ...(record.grant.permissions.includes('agent.inject')
            ? { crossSessionInject: record.crossSessionInject }
            : {}),
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

  async stage(source: PluginInstallSource, version?: string) {
    this.sweepStaged();
    const result =
      source.kind === 'market'
        ? await this.stageFromMarket(source.id, version)
        : await stagePlugin(this.options.root, source, this.options.hostVersion);
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
      env: m.env,
      interop: m.interop.call,
      resident: m.resident,
      styles: grant.styles,
      events: m.contributes.events.map(({ event, mode, failClosed }) => ({
        event,
        mode,
        failClosed,
      })),
      schedules: m.contributes.schedules.map(({ id, intervalSeconds }) => ({
        id,
        intervalSeconds,
      })),
      tools: m.contributes.agentTools.map(({ name, description }) => ({ name, description })),
      hasRenderer: m.renderer !== undefined,
      warnings: [...staged.warnings, ...versionWarnings(m.version, existing?.version)],
      ...(existing ? { existingVersion: existing.version } : {}),
      expands: existing ? grantExpands(existing.grant, grant) : true,
    };
    return { ok: true as const, preview };
  }

  /** 下载并校验市场包后按 zip 暂存；包里的插件 id 必须与市场条目一致 */
  private async stageFromMarket(id: string, version?: string) {
    const market = this.options.market;
    if (!market) return { ok: false as const, error: '当前环境不支持插件市场' };
    const tmpDir = join(this.options.root, 'market', 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const zip = join(tmpDir, `${randomUUID()}.zip`);
    try {
      const got = await market.download(id, version, zip);
      if (!got.ok) return got;
      const result = await stagePlugin(
        this.options.root,
        { kind: 'zip', path: zip },
        this.options.hostVersion
      );
      if (result.ok && result.staged.manifest.id !== id) {
        discardStaged(this.options.root, result.staged);
        return { ok: false as const, error: `市场包里的插件不是 ${id}` };
      }
      return result;
    } finally {
      rmSync(zip, { force: true });
    }
  }

  async marketList(refresh: boolean): Promise<ExtensionPluginMarketList> {
    const market = this.options.market;
    if (!market) return { ok: false, error: '当前环境不支持插件市场', chinaMirror: false };
    const chinaMirror = market.chinaMirror();
    const r = await market.index({ refresh });
    if (!r.ok) return { ok: false, error: r.error, chinaMirror };
    return {
      ok: true,
      stale: r.stale,
      chinaMirror,
      plugins: r.index.plugins.map((p) => {
        const installed = this.records.find((rec) => rec.id === p.id)?.version;
        const icon = marketIconUrl(p.icon);
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          tier: p.tier,
          tags: p.tags,
          ...(p.homepage ? { homepage: p.homepage } : {}),
          ...(icon ? { icon } : {}),
          latest: p.latest,
          permissions: p.versions.find((v) => v.version === p.latest)?.permissions ?? [],
          ...(installed ? { installedVersion: installed } : {}),
          updateAvailable: installed !== undefined && isNewerPluginVersion(p.latest, installed),
        };
      }),
    };
  }

  setMarketChinaMirror(on: boolean): void {
    this.options.market?.setChinaMirror(on);
  }

  /** 从记录的安装来源重新暂存；之后和普通更新一样确认、按授权是否扩大分流 */
  async restage(id: string) {
    return this.withIdLock(id, async () => {
      this.prepareFailed.delete(id);
      this.invalidatePackageCache(id);
      const source = this.records.find((r) => r.id === id)?.source;
      if (!source) return { ok: false as const, error: '没有记录安装来源，请重新选择插件' };
      const result = await this.stage(source);
      if (result.ok && result.preview.id !== id) {
        this.discard(result.preview.token);
        return { ok: false as const, error: `来源里的插件已经不是 ${id}` };
      }
      return result;
    });
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
    return this.withIdLock(entry.staged.manifest.id, async () => {
      if (this.staged.get(token) !== entry)
        return { ok: false, error: '安装已过期，请重新选择插件' };
      this.staged.delete(token);
      const { manifest } = entry.staged;
      const { source } = entry;
      this.prepareFailed.delete(manifest.id);
      this.invalidatePackageCache(manifest.id);
      const dir = commitStaged(this.options.root, entry.staged);
      const trial = await this.trialLoad(manifest, dir);
      if (!trial.ok) {
        removePackage(this.options.root, manifest.id, dir);
        if (!this.records.some((r) => r.id === manifest.id)) {
          rmSync(join(this.options.root, 'packages', manifest.id), {
            recursive: true,
            force: true,
          });
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
          crossSessionInject: false,
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
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    return this.withIdLock(id, async () => {
      if (!enabled) this.stopProcess(id);
      else {
        this.recentErrors.delete(id);
        this.prepareFailed.delete(id);
      }
      const result = this.applyAndPersist(id, { type: enabled ? 'enable' : 'disable' });
      if (result.ok) this.syncBackground();
      return result;
    });
  }

  /** 允许或禁止插件向非发起会话注入消息；只对申请了 agent.inject 的插件有效 */
  setCrossSessionInject(id: string, allowed: boolean): { ok: boolean; error?: string } {
    const record = this.records.find((r) => r.id === id);
    if (!record) return { ok: false, error: '插件未安装' };
    if (!record.grant.permissions.includes('agent.inject'))
      return { ok: false, error: '插件没有申请 agent.inject' };
    record.crossSessionInject = allowed;
    this.persist();
    return { ok: true };
  }

  approvePending(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.withIdLock(id, async () => {
      const oldDir = this.records.find((r) => r.id === id)?.dir;
      const result = this.applyAndPersist(id, { type: 'approve-pending' });
      if (result.ok && oldDir) {
        this.prepareFailed.delete(id);
        this.invalidatePackageCache(id);
        this.stopProcess(id);
        removePackage(this.options.root, id, oldDir);
        this.syncBackground();
      }
      return result;
    });
  }

  rejectPending(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.withIdLock(id, async () => {
      const pendingDir = this.records.find((r) => r.id === id)?.pending?.dir;
      const result = this.applyAndPersist(id, { type: 'reject-pending' });
      if (result.ok && pendingDir) {
        this.prepareFailed.delete(id);
        this.invalidatePackageCache(id);
        removePackage(this.options.root, id, pendingDir);
      }
      return result;
    });
  }

  /** 拒绝新调用 → 取消挂起调用 → 停进程 → 删副本与数据目录 */
  async uninstall(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.withIdLock(id, async () => {
      const record = this.records.find((r) => r.id === id);
      if (!record) return { ok: false, error: '插件未安装' };
      this.records = this.records.filter((r) => r.id !== id);
      this.persist();
      this.stopProcess(id);
      this.removeLocalFiles(id);
      await this.logger.discard(id);
      rmSync(this.logPath(id), { force: true });
      rmSync(`${this.logPath(id)}.1`, { force: true });
      this.recentErrors.delete(id);
      this.prepareFailed.delete(id);
      this.invalidatePackageCache(id);
      this.syncBackground();
      return { ok: true };
    });
  }

  /** 登记表问题的待确认提示；落盘保存，重启不丢，用户确认或重装后消失 */
  registryNotice(): RegistryNotice | null {
    const notice = this.readNotice();
    if (!notice) return null;
    const discarded = notice.discarded.filter((id) => !this.records.some((r) => r.id === id));
    if (discarded.length === 0 && !notice.unreadable) return null;
    return { discarded, ...(notice.unreadable ? { unreadable: true } : {}) };
  }

  dismissRegistryNotice(): void {
    rmSync(this.noticePath(), { force: true });
  }

  /** 插件包、数据、配置、产出与页面状态；日志由调用方决定是否保留 */
  private removeLocalFiles(id: string): void {
    rmSync(join(this.options.root, 'packages', id), { recursive: true, force: true });
    rmSync(pluginDataPath(this.options.root, id), { recursive: true, force: true });
    rmSync(this.configPath(id), { force: true });
    this.artifacts.removePlugin(id);
    this.viewState.remove(id);
  }

  /**
   * 启动时处理登记表问题。只删确实读到并决定丢弃的 id；登记表读不出时不碰任何文件，
   * 也不按「磁盘上有、登记表里没有」推断残留——登记表坏过一次后再装新插件，它会变得可读但不完整。
   */
  private settleRegistry(discarded: string[], unreadable: boolean): void {
    const log = (message: string) => this.appendLog('extension-plugins', 'warn', message);
    if (unreadable) {
      preserveUnreadableRegistry(this.options.root);
      log('登记表读取失败，已另存为 registry.json.unreadable，未清理任何插件文件');
      this.writeNotice({ discarded: this.readNotice()?.discarded ?? [], unreadable: true });
    }
    if (discarded.length > 0) {
      log(`登记记录格式已变更，已丢弃并清理：${discarded.join(', ')}；请重新安装`);
      const previous = this.readNotice();
      this.writeNotice({
        discarded: [...new Set([...(previous?.discarded ?? []), ...discarded])],
        ...(previous?.unreadable ? { unreadable: true } : {}),
      });
      for (const id of discarded) {
        if (this.records.some((r) => r.id === id)) continue;
        this.removeLocalFiles(id);
        this.logger.discard(id);
        rmSync(this.logPath(id), { force: true });
        rmSync(`${this.logPath(id)}.1`, { force: true });
      }
      this.persist();
    }
    if (unreadable) return;
    const known = new Set(this.records.map((record) => record.id));
    let names: string[];
    try {
      names = readdirSync(join(this.options.root, 'packages'));
    } catch {
      names = [];
    }
    const strays = names.filter((id) => !known.has(id) && !discarded.includes(id));
    if (strays.length > 0) log(`发现没有登记的插件目录，已保留未删除：${strays.join(', ')}`);
  }

  private noticePath(): string {
    return join(this.options.root, 'registry-notice.json');
  }

  private readNotice(): RegistryNotice | null {
    try {
      const raw = JSON.parse(readFileSync(this.noticePath(), 'utf8')) as unknown;
      if (typeof raw !== 'object' || raw === null) return null;
      const { discarded, unreadable } = raw as Record<string, unknown>;
      if (!Array.isArray(discarded)) return null;
      return {
        discarded: discarded.filter(
          (id): id is string => typeof id === 'string' && PLUGIN_ID_PATTERN.test(id)
        ),
        ...(unreadable === true ? { unreadable: true } : {}),
      };
    } catch {
      return null;
    }
  }

  private writeNotice(notice: RegistryNotice): void {
    try {
      mkdirSync(this.options.root, { recursive: true });
      writeFileSync(this.noticePath(), JSON.stringify(notice), { mode: 0o600 });
    } catch {}
  }

  /** 已保存的配置值（含密钥），不含缺省 */
  configValues(id: string): Record<string, ConfigValue> {
    const record = this.records.find((r) => r.id === id);
    if (!record) return {};
    const manifest = this.load(record.id, record.dir);
    if (!manifest) return {};
    const key = `${id}/${record.dir}`;
    const cached = this.configCache.get(key);
    if (cached) return { ...cached };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.configPath(id), 'utf8'));
    } catch {
      this.configCache.set(key, {});
      return {};
    }
    const out: Record<string, ConfigValue> = {};
    if (typeof raw !== 'object' || raw === null) {
      this.configCache.set(key, out);
      return {};
    }
    for (const field of manifest.contributes.configuration) {
      const value = (raw as Record<string, unknown>)[field.key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        out[field.key] = value;
    }
    this.configCache.set(key, out);
    return { ...out };
  }

  /** 给插件进程：类型化的当前值，缺省补上 default */
  pluginConfig(id: string): Record<string, ConfigValue> {
    const manifest = this.installedManifest(id);
    if (!manifest) return {};
    const stored = this.configValues(id);
    const out: Record<string, ConfigValue> = {};
    for (const field of manifest.contributes.configuration) {
      const value = stored[field.key];
      if (value !== undefined && configMatches(field, value)) out[field.key] = value;
      else if (field.default !== undefined) out[field.key] = field.default;
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
          ...(!f.secret && value !== undefined ? { value: String(value) } : {}),
        };
      }),
    };
  }

  /** 省略的键不变，null 清除；只接受清单声明的键 */
  setConfig(
    id: string,
    patch: Record<string, string | number | boolean | null>
  ): Promise<{ ok: boolean; error?: string }> {
    return this.withIdLock(id, async () => {
      const manifest = this.installedManifest(id);
      if (!manifest) return { ok: false, error: '插件未安装' };
      const fields = new Map(manifest.contributes.configuration.map((field) => [field.key, field]));
      const next = this.configValues(id);
      for (const [key, value] of Object.entries(patch)) {
        const field = fields.get(key);
        if (!field) return { ok: false, error: `未知配置项 ${key}` };
        if (value === null) delete next[key];
        else {
          const parsed = coerceConfig(field, value);
          if (typeof parsed === 'object') return { ok: false, error: parsed.error };
          next[key] = parsed;
        }
      }
      const target = this.configPath(id);
      mkdirSync(join(this.options.root, 'config'), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      renameSync(tmp, target);
      this.invalidatePackageCache(id);
      this.touch();
      return { ok: true };
    });
  }

  toolsForSpawn(): PluginToolDescriptor[] {
    return this.enabled().flatMap(({ id, manifest }) => [
      ...manifest.contributes.agentTools.map((tool) => this.describeTool(id, tool)),
      ...this.dynamic.toolsFor(id).map((tool) => this.describeTool(id, tool)),
    ]);
  }

  /** 无订阅且没有 agent.inject 时不给会话下发事件计划 */
  eventPlanForSpawn(): PluginEventPlan | null {
    const observe = new Set<string>();
    const intercept: { event: string; tools?: string[] }[] = [];
    let inject = false;
    for (const { manifest } of this.enabled()) {
      if (manifest.permissions.includes('agent.inject')) inject = true;
      for (const sub of manifest.contributes.events) {
        if (isHostPluginEvent(sub.event)) continue;
        if (sub.mode === 'observe') {
          observe.add(sub.event);
          continue;
        }
        const existing = intercept.find((item) => item.event === sub.event);
        if (!existing) {
          intercept.push({ event: sub.event, ...(sub.tools ? { tools: [...sub.tools] } : {}) });
          continue;
        }
        if (!sub.tools || !existing.tools) delete existing.tools;
        else existing.tools = [...new Set([...existing.tools, ...sub.tools])];
      }
    }
    if (observe.size === 0 && intercept.length === 0 && !inject) return null;
    return { observe: [...observe].sort(), intercept, inject };
  }

  /** 拉起声明了动态工具的插件，让 toolsForSpawn 能看到它们；单个最多等 5 秒 */
  async prepareForSpawn(): Promise<void> {
    if (this.isDisposed) return;
    const targets = this.enabled().filter(
      (entry) => entry.manifest.contributes.dynamic.tools > 0 && entry.manifest.main
    );
    const timeoutMs = this.options.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS;
    await Promise.all(
      targets.map(async ({ id }) => {
        if (this.isDisposed || this.prepareFailed.has(id)) return;
        let proc: PluginProcess;
        try {
          proc = this.processFor(id);
        } catch {
          return;
        }
        const spawn = proc.ready();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            spawn,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
              timer.unref?.();
            }),
          ]);
          this.prepareFailed.delete(id);
        } catch (error) {
          const failed = (error as { code?: string }).code === 'PLUGIN_INIT_FAILED';
          this.prepareFailed.add(id);
          if (failed) this.noteSpawnFailure(id, spawn);
          else {
            void spawn.then(
              () => {
                this.prepareFailed.delete(id);
              },
              (later: unknown) => {
                if ((later as { code?: string }).code !== 'PLUGIN_INIT_FAILED') return;
                this.prepareFailed.add(id);
                this.noteSpawnFailure(id, spawn);
              }
            );
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      })
    );
  }

  skillPathsForSpawn(activePresetId?: string): string[] {
    return this.enabled().flatMap(({ id, dir, manifest }) => {
      const root = pluginPackagePath(this.options.root, id, dir);
      return this.contributedSkills(id, manifest, activePresetId).map((rel) => resolve(root, rel));
    });
  }

  /**
   * 已启用插件声明的子代理类型；正文读不出的跳过并记日志。技能目录不受预设范围影响。
   * 传 scope 时按会话生效的插件预设过滤：被预设圈定的类型只在该预设下发；不传则列出全部（设置页、派发）
   */
  agentTypesForSpawn(scope?: { activePresetId?: string }): NativePluginAgentDef[] {
    return this.enabled().flatMap(({ id, dir, manifest }) => {
      const root = pluginPackagePath(this.options.root, id, dir);
      const { scoped, selected } = presetSelection(
        manifest,
        id,
        scope?.activePresetId,
        (preset) => preset.agentTypes ?? []
      );
      return manifest.contributes.agentTypes.flatMap((type) => {
        if (scope && scoped.has(type.name) && !selected.has(type.name)) return [];
        const prompt = this.readText(id, dir, type.systemPrompt);
        if (!prompt.ok) {
          this.warnAgentTypeOnce(
            id,
            `子代理类型 ${type.name} 的 systemPrompt（${type.systemPrompt}）读取失败，已跳过`
          );
          return [];
        }
        return [
          {
            pluginId: id,
            name: type.name,
            description: type.description,
            systemPrompt: prompt.content,
            tools: type.tools,
            skillPaths: type.skills.map((rel) => resolve(root, rel)),
            ...(type.modelMode ? { modelMode: type.modelMode } : {}),
          },
        ];
      });
    });
  }

  /** 供 pluginRuntime 合并子代理类型；被重名丢弃的写进对应插件日志 */
  agentTypeSource(): NativeAgentTypeSource {
    return {
      list: () => this.agentTypesForSpawn(),
      reportDropped: (dropped: PluginAgentTypeDrop[]) => {
        for (const drop of dropped) {
          if (!drop.pluginId) continue;
          const by =
            drop.shadowedBy === 'custom'
              ? '用户自定义类型'
              : drop.shadowedBy === 'claude'
                ? 'Claude 插件'
                : drop.shadowedBy === 'native'
                  ? '排序更前的 Enso 插件'
                  : '内置类型或保留名';
          this.warnAgentTypeOnce(drop.pluginId, `子代理类型 ${drop.name} 与${by}同名，已被忽略`);
        }
      },
    };
  }

  private warnAgentTypeOnce(id: string, message: string): void {
    const key = `${id}\0${message}`;
    if (this.agentTypeWarned.has(key)) return;
    this.agentTypeWarned.add(key);
    this.appendLog(id, 'warn', message);
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
        model?: { providerId: string; modelId: string };
        thinkingLevel?: PluginPresetContrib['thinkingLevel'];
        approvalMode?: PluginPresetContrib['approvalMode'];
        disabledTools?: string[];
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
      return this.readText(loaded.id, loaded.dir, rel);
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
      ...(preset.model ? { model: preset.model } : {}),
      ...(preset.thinkingLevel ? { thinkingLevel: preset.thinkingLevel } : {}),
      ...(preset.approvalMode ? { approvalMode: preset.approvalMode } : {}),
      ...(preset.disabledTools?.length ? { disabledTools: [...preset.disabledTools] } : {}),
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
    onProgress?: (text: string) => void;
    /** 子会话发起时的来源；sessionId 仍是所属主会话 */
    agent?: PluginAgentSource;
  }): Promise<PluginToolOutcome> {
    const parsed = parsePluginToolName(input.toolName);
    if (!parsed) throw pluginError('NOT_FOUND', `不是插件工具：${input.toolName}`);
    const manifest = this.enabledManifest(parsed.pluginId);
    if (!manifest) throw pluginError('PLUGIN_DISABLED', '插件未启用');
    const declared =
      manifest.contributes.agentTools.find((tool) => tool.name === parsed.toolName) ??
      this.dynamic.toolsFor(parsed.pluginId).find((tool) => tool.name === parsed.toolName);
    let tool = declared;
    if (!tool && manifest.contributes.dynamic.tools > 0 && manifest.main) {
      const proc = this.processFor(parsed.pluginId);
      try {
        await proc.ready();
      } catch (error) {
        if ((error as { code?: string }).code === 'PLUGIN_INIT_FAILED')
          this.noteSpawnFailure(parsed.pluginId, this.lastSpawn.get(proc));
        throw error;
      }
      tool = this.dynamic.toolsFor(parsed.pluginId).find((item) => item.name === parsed.toolName);
    }
    if (!tool) throw pluginError('NOT_FOUND', `插件没有声明工具 ${parsed.toolName}`);
    const value = await this.invoke(
      parsed.pluginId,
      'tool.execute',
      { name: parsed.toolName, args: input.args },
      {
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        gesture: false,
        timeoutMs: tool.timeoutMs ?? TOOL_TIMEOUT_MS,
        kind: 'tool',
        onProgress: input.onProgress,
        ...(input.agent ? { agent: input.agent } : {}),
      },
      input.signal
    );
    const result = value as PluginToolResult;
    if (!result || typeof result.content !== 'string')
      throw pluginError('BAD_RESULT', '插件工具返回值不合法');
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_TOOL_RESULT_BYTES)
      throw pluginError('TOO_LARGE', '插件工具结果超过 1MB');
    const ids = Array.isArray(result.artifacts)
      ? result.artifacts.filter((id): id is string => typeof id === 'string')
      : [];
    return {
      content: result.content,
      ...(result.details !== undefined ? { details: result.details } : {}),
      artifacts: ids.flatMap((id) => {
        const info = this.artifacts.info(id);
        return info?.pluginId === parsed.pluginId ? [info] : [];
      }),
    };
  }

  async dispatchEvent(input: {
    sessionId: string;
    projectRoot: string | null;
    event: PluginEventName;
    data: unknown;
    /** 子会话事件：只投给通知型订阅，也不等 before_compact，避免并行子代理互相拖慢 */
    agent?: PluginAgentSource;
  }): Promise<void> {
    const targets = this.enabled().filter((entry) =>
      entry.manifest.contributes.events.some(
        (sub) => sub.event === input.event && (!input.agent || sub.mode === 'observe')
      )
    );
    const wait = input.event === 'before_compact' && !input.agent;
    if (!wait) {
      for (const entry of targets) this.enqueueObserve(entry.id, input);
      return;
    }
    const send = (id: string) =>
      this.invoke(
        id,
        'event.dispatch',
        { event: input.event, data: input.data },
        {
          sessionId: input.sessionId,
          projectRoot: input.projectRoot,
          gesture: false,
          timeoutMs: BEFORE_COMPACT_TIMEOUT_MS,
          kind: 'event',
          ...(input.agent ? { agent: input.agent } : {}),
        }
      ).catch((error: unknown) => {
        this.appendLog(
          id,
          'warn',
          `事件 ${input.event} 失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
    await Promise.all(
      targets.filter((entry) => this.canDeliverObserve(entry.id)).map((entry) => send(entry.id))
    );
  }

  async intercept<E extends PluginInterceptEvent>(input: {
    sessionId: string;
    projectRoot: string | null;
    event: E;
    payload: InterceptPayload[E];
    deadlineMs?: number;
    /**
     * 子会话发起：只拦 tool_call，单插件 2 秒、合计 5 秒，熔断与主会话分开计数；
     * 其余事件不询问插件直接放行。每次拦截从自己开始时计时，不占别的会话的预算。
     */
    agent?: PluginAgentSource;
  }): Promise<InterceptResult[E]> {
    const initial = initialInterceptState(input.event, input.payload);
    const child = input.agent !== undefined;
    if (child && !isChildInterceptEvent(input.event)) return initial.result;
    const deadline =
      Date.now() +
      (input.deadlineMs ?? (child ? CHILD_INTERCEPT_TOTAL_TIMEOUT_MS : INTERCEPT_TOTAL_TIMEOUT_MS));
    const perPluginMs = child ? CHILD_INTERCEPT_TIMEOUT_MS : INTERCEPT_TIMEOUT_MS;
    const breakerKey = child ? `${CHILD_BREAKER_PREFIX}${input.event}` : input.event;
    let targets: (Loaded & { id: string })[];
    try {
      targets = this.enabled()
        .filter((entry) =>
          entry.manifest.contributes.events.some(
            (sub) =>
              sub.event === input.event &&
              sub.mode === 'intercept' &&
              interceptsTool(sub, input.payload)
          )
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } catch (error) {
      // 宿主自身出错（不属于任何插件）时放行；插件的失败在下面逐个按 failClosed 处理
      this.appendLog(
        'extension-plugins',
        'warn',
        `拦截失败：${error instanceof Error ? error.message : String(error)}`
      );
      return initial.result;
    }
    let state = initial;
    for (const entry of targets) {
      if (state.done) break;
      const sub = entry.manifest.contributes.events.find((item) => item.event === input.event);
      const breaker = this.interceptBreaker(entry.id, breakerKey);
      if (breaker === 'open') continue;
      const remaining = deadline - Date.now();
      try {
        if (remaining <= 0) throw new InterceptDeadlineError();
        const value = await this.invoke(
          entry.id,
          'event.dispatch',
          { event: input.event, data: state.payload },
          {
            sessionId: input.sessionId,
            projectRoot: input.projectRoot,
            gesture: false,
            timeoutMs: Math.min(perPluginMs, remaining),
            kind: 'event',
            ...(input.agent ? { agent: input.agent } : {}),
          }
        );
        state = applyInterceptResult(state, value);
        this.settleIntercept(entry.id, breakerKey, true, entry.manifest.name);
      } catch (error) {
        this.appendLog(
          entry.id,
          'warn',
          `拦截 ${input.event} 失败：${error instanceof Error ? error.message : String(error)}`
        );
        // 总时长用尽是前面插件拖慢的，不计入本插件的失败
        if (!(error instanceof InterceptDeadlineError))
          this.settleIntercept(entry.id, breakerKey, false, entry.manifest.name);
        if (sub?.failClosed) return failClosedResult(input.event, entry.manifest.name);
      }
    }
    return state.result;
  }

  /** 拦截熔断：open 期间跳过该插件（放行）；到期后放一次试探 */
  private interceptBreaker(pluginId: string, event: string): 'closed' | 'open' | 'trial' {
    const state = this.interceptFailures.get(`${pluginId}:${event}`);
    if (!state || state.openUntil === 0) return 'closed';
    return Date.now() < state.openUntil ? 'open' : 'trial';
  }

  private settleIntercept(pluginId: string, event: string, ok: boolean, name: string): void {
    const key = `${pluginId}:${event}`;
    const state = this.interceptFailures.get(key) ?? { failures: 0, openUntil: 0 };
    if (ok) {
      if (!this.interceptFailures.delete(key) || state.openUntil === 0) return;
      this.appendLog(pluginId, 'info', `插件 ${name} 的 ${breakerLabel(event)} 检查已恢复`);
      this.touch();
      return;
    }
    state.failures += 1;
    this.interceptFailures.set(key, state);
    if (state.failures < INTERCEPT_BREAKER_FAILURES) return;
    state.openUntil = Date.now() + INTERCEPT_BREAKER_MS;
    this.appendLog(
      pluginId,
      'warn',
      `插件 ${name} 的 ${breakerLabel(event)} 检查连续失败，已临时放行 ${INTERCEPT_BREAKER_MS / 1000} 秒`
    );
    this.touch();
  }

  /** 停用、卸载、更新后重新计数；修好发版后不必等熔断到期 */
  private clearInterceptBreakers(pluginId: string): void {
    const prefix = `${pluginId}:`;
    let cleared = false;
    for (const key of [...this.interceptFailures.keys()])
      if (key.startsWith(prefix)) cleared = this.interceptFailures.delete(key) || cleared;
    if (cleared) this.touch();
  }

  private openInterceptBreakers(pluginId: string): { event: string; until: number }[] {
    const now = Date.now();
    const prefix = `${pluginId}:`;
    return [...this.interceptFailures]
      .filter(([key, state]) => key.startsWith(prefix) && now < state.openUntil)
      .map(([key, state]) => ({
        event: breakerLabel(key.slice(prefix.length)),
        until: state.openUntil,
      }));
  }

  listArtifacts(pluginId?: string): PluginArtifactInfo[] {
    return this.artifacts.list(pluginId);
  }

  artifactInfo(id: string): PluginArtifactInfo | null {
    return this.artifacts.info(id);
  }

  artifactPath(id: string): string | null {
    return this.artifacts.path(id);
  }

  deleteArtifact(id: string): boolean {
    return this.artifacts.delete(id);
  }

  viewStateGet(pluginId: string): Record<string, string> {
    return this.viewState.get(pluginId);
  }

  viewStateSet(
    pluginId: string,
    patch: Record<string, string | null>
  ): { ok: boolean; error?: string } {
    return this.viewState.set(pluginId, patch);
  }

  /** 启动后拉起常驻插件并挂上定时任务；重复调用只同步一次 */
  startBackground(): void {
    this.background = true;
    this.syncBackground();
  }

  hasRunningPlugins(): boolean {
    for (const proc of this.processes.values()) if (proc.running) return true;
    return false;
  }

  private describeTool(
    pluginId: string,
    tool: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      timeoutMs?: number;
    }
  ): PluginToolDescriptor {
    return {
      name: pluginToolName(pluginId, tool.name),
      description: tool.description,
      parameters: tool.parameters,
      pluginId,
      ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
    };
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
    /** 来自远端窗口：不能动宿主桌面（剪贴板、外链） */
    remote?: boolean;
  }): Promise<unknown> {
    const manifest = this.enabledManifest(input.pluginId);
    if (!manifest) throw pluginError('PLUGIN_DISABLED', '插件未启用');
    const declared =
      input.method === 'command.run'
        ? manifest.contributes.commands.some((c) => c.id === input.payload.id) ||
          this.dynamic.commandsFor(input.pluginId).some((c) => c.id === input.payload.id)
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
        remote: input.remote === true,
        timeoutMs: uiCallTimeout(manifest, input.method, input.payload),
        kind: 'ui',
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
    if (!record || !isPluginRelativePath(rel) || rel === '.') return null;
    // 停用的插件只放出清单 icon，供设置页显示
    if (record.state !== 'enabled' && this.load(record.id, record.dir)?.icon !== rel) return null;
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
    this.syncBackground();
  }

  /** 插件进程的输出与异常，落在 Main 私有目录；超过 1MB 轮转一次 */
  appendLog(id: string, level: PluginLogLevel, message: string): void {
    this.logger.append(id, level, message);
    if (level === 'error') this.recordError(id, message);
  }

  recordError(id: string, message: string): void {
    this.recentErrors.set(id, { at: Date.now(), message: message.slice(0, MAX_ERROR_CHARS) });
  }

  /** 日志末尾；没有日志返回空串 */
  logs(id: string, maxBytes = DEFAULT_LOG_TAIL_BYTES): Promise<string> {
    return this.logger.read(id, maxBytes);
  }

  /** 启动后稍等检查一次，之后每天一次；只查已启用的插件 */
  startUpdateChecks(): void {
    if (this.isDisposed || this.updateTimer) return;
    const run = (delay: number) => {
      if (this.isDisposed) return;
      this.updateTimer = setTimeout(() => {
        void this.checkUpdates({ enabledOnly: true }).finally(() => {
          if (this.isDisposed || !this.updateTimer) return;
          run(UPDATE_CHECK_INTERVAL_MS);
        });
      }, delay);
      this.updateTimer.unref?.();
    };
    run(UPDATE_CHECK_FIRST_DELAY_MS);
  }

  /** GitHub 来源只拉清单比较版本；市场来源对比签名索引。不下载整包、不自动安装 */
  async checkUpdates(options: { enabledOnly?: boolean } = {}) {
    const marketRecords = this.records.filter(
      (r) => r.source?.kind === 'market' && (!options.enabledOnly || r.state === 'enabled')
    );
    const marketResults = await this.checkMarketUpdates(marketRecords);
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
    results.push(...marketResults);
    if (results.length > 0) this.touch();
    return {
      checked: results.length,
      available: results.filter((r) => r === 'available').length,
      failed: results.filter((r) => r === 'failed').length,
    };
  }

  private async checkMarketUpdates(records: PluginRecord[]) {
    if (records.length === 0 || !this.options.market) return [];
    const r = await this.options.market.index({ refresh: true });
    return records.map((record) => {
      if (!r.ok) {
        this.updates.set(record.id, { error: r.error });
        return 'failed' as const;
      }
      const latest = r.index.plugins.find((p) => p.id === record.id)?.latest;
      const update =
        latest && isNewerPluginVersion(latest, record.version) ? { version: latest } : {};
      this.updates.set(record.id, update);
      return update.version ? ('available' as const) : ('current' as const);
    });
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

  dispose(): Promise<void> {
    if (this.disposed) return this.disposed;
    this.isDisposed = true;
    this.background = false;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = null;
    this.armSchedules();
    for (const id of [...this.residentTimers.keys()]) this.cancelRestart(id);
    const waits = [...this.processes.values()].map((proc) => proc.whenStopped());
    for (const id of [...this.processes.keys()]) this.stopProcess(id);
    this.disposed = Promise.all([...waits, this.logger.dispose()]).then(() => undefined);
    return this.disposed;
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
      remote?: boolean;
      timeoutMs: number;
      kind?: 'tool' | 'ui' | 'event' | 'schedule' | 'export';
      depth?: number;
      onProgress?: (text: string) => void;
      agent?: PluginAgentSource;
    },
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) throw pluginError('ABORTED', '调用已取消');
    const proc = this.processFor(pluginId);
    const spawn = proc.ready();
    const invocationId = this.gate.invocations.create({
      pluginId,
      sessionId: ctx.sessionId,
      projectRoot: ctx.projectRoot,
      gesture: ctx.gesture,
      origin: ctx.origin ?? null,
      remote: ctx.remote === true,
      kind: ctx.kind,
      depth: ctx.depth,
    });
    if (ctx.onProgress) this.progressTaps.set(invocationId, createProgressTap(ctx.onProgress));
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
        ...(ctx.agent ? { agent: ctx.agent } : {}),
        timeoutMs: ctx.timeoutMs,
      });
    } catch (error) {
      // 超时或失败后中止这次调用里仍在进行的宿主请求（如 MCP 调用）
      this.gate.invocations.cancel(invocationId);
      if ((error as { code?: string }).code === 'PLUGIN_INIT_FAILED')
        this.noteSpawnFailure(pluginId, spawn);
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.gate.invocations.finish(invocationId);
      this.progressTaps.delete(invocationId);
    }
  }

  private processFor(pluginId: string): PluginProcess {
    if (this.isDisposed) throw pluginError('NOT_FOUND', '插件服务已关闭');
    const existing = this.processes.get(pluginId);
    if (existing) return existing;
    const record = this.records.find((r) => r.id === pluginId);
    const manifest = record ? this.load(record.id, record.dir) : null;
    if (!record || !manifest?.main) throw pluginError('NOT_FOUND', '插件没有 main');
    const proc = this.createProcess(manifest, record.dir, (unexpected) => {
      if (!unexpected) return;
      this.noteSpawnFailure(pluginId, this.lastSpawn.get(proc));
      this.scheduleResidentRestart(pluginId);
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
    let proc!: PluginProcess;
    proc = new TrackedPluginProcess(
      {
        fork: this.options.fork,
        hostPath: this.options.hostPath,
        env: {
          ...pluginProcessEnv(this.options.env, this.options.sourceEnv, manifest.env),
          ENSO_PLUGIN_DATA: dataDir,
        },
        resident: manifest.resident,
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
          if (this.processes.get(manifest.id) === proc && this.dynamic.clear(manifest.id))
            this.touch();
          onExit(unexpected);
        },
        onLog: (level, message) => this.appendLog(manifest.id, level, message),
      },
      (pending) => {
        this.lastSpawn.set(proc, pending);
        void pending.then(
          () => {
            this.countedSpawns.delete(pending);
          },
          () => undefined
        );
      }
    );
    return proc;
  }

  private async trialLoad(manifest: ExtensionPluginManifest, dir: string) {
    if (!manifest.main) return { ok: true as const };
    const previous = this.gateManifests.get(manifest.id);
    this.gateManifests.set(manifest.id, manifest);
    this.trialing.add(manifest.id);
    this.trialCounts.set(manifest.id, { tools: 0, commands: 0 });
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
      this.trialing.delete(manifest.id);
      this.trialCounts.delete(manifest.id);
      if (previous) this.gateManifests.set(manifest.id, previous);
      else this.gateManifests.delete(manifest.id);
      proc.stop();
      if (!this.processes.has(manifest.id) && this.dynamic.clear(manifest.id)) this.touch();
    }
  }

  private stopProcess(id: string): void {
    this.clearInterceptBreakers(id);
    this.cancelRestart(id);
    this.gate.invocations.cancelPlugin(id);
    this.processes.get(id)?.stop();
    this.processes.delete(id);
    if (this.dynamic.clear(id)) this.touch();
  }

  private touch(): void {
    if (this.isDisposed) return;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      if (this.isDisposed) return;
      for (const listener of this.listeners) listener();
    }, CHANGE_DEBOUNCE_MS);
    this.changeTimer.unref?.();
  }

  private inject(
    pluginId: string,
    input: {
      sessionId: string;
      text: string;
      images: PluginInjectImage[];
      deliverAs: 'steer' | 'followUp' | 'nextTurn';
      triggerTurn: boolean;
    }
  ): { ok: true } | { ok: false; error: string } {
    const manifest = this.enabledManifest(pluginId) ?? this.gateManifests.get(pluginId);
    const bridge = this.options.sessionBridge?.() ?? null;
    if (!manifest || !bridge) return { ok: false, error: '当前环境不能注入消息' };
    return bridge.inject(input.sessionId, {
      pluginId,
      pluginName: manifest.name,
      text: input.text,
      images: input.images,
      deliverAs: input.deliverAs,
      triggerTurn: input.triggerTurn,
    });
  }

  private callExport(
    callerId: string,
    targetId: string,
    name: string,
    args: unknown,
    depth: number,
    caller: { sessionId: string | null; projectRoot: string | null; signal?: AbortSignal }
  ): Promise<unknown> {
    const target = this.enabledManifest(targetId);
    if (!target) throw pluginError('PLUGIN_DISABLED', '目标插件未启用');
    const exported = target.contributes.exports.find((item) => item.name === name);
    if (!exported) throw pluginError('NOT_FOUND', `插件没有导出 ${name}`);
    return this.invoke(
      targetId,
      'export.call',
      { name, args, caller: callerId },
      {
        sessionId: caller.sessionId,
        projectRoot: caller.projectRoot,
        gesture: false,
        timeoutMs: exported.timeoutMs ?? TOOL_TIMEOUT_MS,
        kind: 'export',
        depth,
      },
      caller.signal
    );
  }

  private registerContrib(pluginId: string, input: Record<string, unknown>): void {
    const manifest = this.gateManifests.get(pluginId) ?? this.enabledManifest(pluginId);
    if (!manifest) throw pluginError('PLUGIN_DISABLED', '插件未启用');
    if (this.trialing.has(pluginId)) {
      this.noteTrialContrib(pluginId, manifest, input);
      return;
    }
    this.dynamic.register(pluginId, manifest, input);
    this.touch();
  }

  private unregisterContrib(pluginId: string, input: Record<string, unknown>): void {
    if (this.trialing.has(pluginId)) return;
    this.dynamic.unregister(pluginId, input);
    this.touch();
  }

  /** 试加载只校验配额，不写进运行期注册表 */
  private noteTrialContrib(
    pluginId: string,
    manifest: ExtensionPluginManifest,
    input: Record<string, unknown>
  ): void {
    const counts = this.trialCounts.get(pluginId) ?? { tools: 0, commands: 0 };
    this.dynamic.validate(pluginId, manifest, input, counts);
    if (input.kind === 'tool') counts.tools += 1;
    else if (input.kind === 'command') counts.commands += 1;
    this.trialCounts.set(pluginId, counts);
  }

  private syncBackground(): void {
    if (this.isDisposed) return;
    this.armSchedules();
    if (!this.background) return;
    const residents = this.enabled()
      .filter((entry) => entry.manifest.resident && entry.manifest.main)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const entry of residents) {
      const live = this.processes.get(entry.id)?.running === true || this.starting.has(entry.id);
      if (live || this.residentTimers.has(entry.id)) continue;
      this.startResident(entry.id);
    }
  }

  private residentCount(): number {
    let count = 0;
    for (const [id, proc] of this.processes) {
      if (this.enabledManifest(id)?.resident && (proc.running || this.starting.has(id))) count += 1;
    }
    for (const id of this.residentTimers.keys()) {
      if (this.starting.has(id) || this.processes.get(id)?.running) continue;
      if (this.enabledManifest(id)?.resident) count += 1;
    }
    return count;
  }

  private startResident(id: string): void {
    if (this.isDisposed) return;
    if (this.residentCount() >= RESIDENT_LIMIT) {
      this.recordError(id, '常驻插件已达上限（5），未启动');
      this.touch();
      return;
    }
    if (this.processes.get(id)?.running || this.starting.has(id)) return;
    this.starting.add(id);
    void this.bootResident(id);
  }

  private async bootResident(id: string): Promise<void> {
    if (this.isDisposed) {
      this.starting.delete(id);
      return;
    }
    let proc: PluginProcess | undefined;
    try {
      proc = this.processFor(id);
      await proc.ready();
      this.touch();
    } catch (error) {
      if (this.isDisposed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.recordError(id, message);
      if ((error as { code?: string }).code === 'PLUGIN_INIT_FAILED')
        this.noteSpawnFailure(id, proc ? this.lastSpawn.get(proc) : undefined);
      if (this.background && this.enabledManifest(id)?.resident) this.scheduleResidentRestart(id);
      this.touch();
    } finally {
      this.starting.delete(id);
    }
  }

  private scheduleResidentRestart(id: string): void {
    if (this.isDisposed || !this.background || !this.enabledManifest(id)?.resident) return;
    this.cancelRestart(id);
    const gen = this.restartGen.get(id) ?? 0;
    const timer = setTimeout(() => {
      this.residentTimers.delete(id);
      if (this.restartGen.get(id) !== gen) return;
      if (this.isDisposed || !this.background || !this.enabledManifest(id)?.resident) return;
      this.startResident(id);
    }, RESIDENT_RESTART_MS);
    this.residentTimers.set(id, timer);
  }

  private cancelRestart(id: string): void {
    const timer = this.residentTimers.get(id);
    if (timer) clearTimeout(timer);
    this.residentTimers.delete(id);
    this.restartGen.set(id, (this.restartGen.get(id) ?? 0) + 1);
  }

  private armSchedules(): void {
    if (this.isDisposed) {
      for (const state of this.scheduleRuns.values()) clearInterval(state.timer);
      this.scheduleRuns.clear();
      return;
    }
    const wanted = new Set<string>();
    if (this.background) {
      for (const { id, manifest } of this.enabled()) {
        for (const schedule of manifest.contributes.schedules) {
          const key = scheduleKey(id, schedule.id);
          wanted.add(key);
          if (this.scheduleRuns.has(key)) continue;
          const state: {
            running: boolean;
            timer: ReturnType<typeof setInterval>;
            lastRunAt?: number;
            lastError?: string;
          } = {
            running: false,
            timer: setInterval(
              () => void this.runSchedule(id, schedule),
              schedule.intervalSeconds * 1000
            ),
          };
          this.scheduleRuns.set(key, state);
        }
      }
    }
    for (const [key, state] of this.scheduleRuns) {
      if (wanted.has(key)) continue;
      clearInterval(state.timer);
      this.scheduleRuns.delete(key);
    }
  }

  private async runSchedule(
    pluginId: string,
    schedule: ExtensionPluginManifest['contributes']['schedules'][number]
  ): Promise<void> {
    const key = scheduleKey(pluginId, schedule.id);
    const state = this.scheduleRuns.get(key);
    if (this.isDisposed || !state || state.running || !this.enabledManifest(pluginId)) return;
    state.running = true;
    try {
      await this.invoke(
        pluginId,
        'schedule.run',
        { id: schedule.id },
        {
          sessionId: null,
          projectRoot: null,
          gesture: false,
          timeoutMs: schedule.timeoutMs ?? SCHEDULE_TIMEOUT_MS,
          kind: 'schedule',
        }
      );
      state.lastRunAt = Date.now();
      delete state.lastError;
    } catch (error) {
      state.lastRunAt = Date.now();
      state.lastError = error instanceof Error ? error.message : String(error);
      this.appendLog(pluginId, 'error', `定时任务 ${schedule.id} 失败：${state.lastError}`);
    } finally {
      if (this.scheduleRuns.get(key) === state) state.running = false;
      this.touch();
    }
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
    if (this.loaded.has(key)) return this.loaded.get(key)?.manifest ?? null;
    try {
      const raw = JSON.parse(
        readFileSync(join(pluginPackagePath(this.options.root, id, dir), MANIFEST_FILE), 'utf8')
      );
      const parsed = parseExtensionPluginManifest(raw, this.options.hostVersion);
      if (!parsed.ok || parsed.manifest.id !== id) {
        this.loaded.set(key, null);
        return null;
      }
      this.loaded.set(key, { dir, manifest: parsed.manifest });
      return parsed.manifest;
    } catch {
      this.loaded.set(key, null);
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
    writeRegistry(this.options.root, { version: REGISTRY_VERSION, plugins: this.records });
    this.touch();
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

  private withIdLock<T>(id: string, run: () => Promise<T>): Promise<T> {
    const prev = this.idTails.get(id) ?? Promise.resolve();
    const next = prev.then(run, run);
    const tail = next.then(
      () => undefined,
      () => undefined
    );
    this.idTails.set(id, tail);
    void tail.finally(() => {
      if (this.idTails.get(id) === tail) this.idTails.delete(id);
    });
    return next;
  }

  private noteSpawnFailure(id: string, spawn: Promise<unknown> | undefined): void {
    if (this.records.find((r) => r.id === id)?.state !== 'enabled') return;
    if (!spawn || this.countedSpawns.has(spawn)) return;
    this.countedSpawns.add(spawn);
    this.recordCrash(id);
  }

  private canDeliverObserve(id: string): boolean {
    const manifest = this.enabledManifest(id);
    if (!manifest?.main) return false;
    if (manifest.resident) return true;
    return this.processes.get(id)?.running === true;
  }

  private enqueueObserve(
    id: string,
    input: {
      sessionId: string;
      projectRoot: string | null;
      event: PluginEventName;
      data: unknown;
      agent?: PluginAgentSource;
    }
  ): void {
    if (!this.canDeliverObserve(id)) return;
    if (this.isDisposed) return;
    const key = observeLaneKey(id, input);
    const job: ObserveJob = {
      sessionId: input.sessionId,
      projectRoot: input.projectRoot,
      data: input.data,
      ...(input.agent ? { agent: input.agent } : {}),
    };
    let lane = this.observeLanes.get(key);
    if (!lane) {
      lane = { running: false, queue: [] };
      this.observeLanes.set(key, lane);
    }
    if (OBSERVE_COALESCE_EVENTS.has(input.event)) {
      if (lane.queue.length > 0) lane.queue[lane.queue.length - 1] = job;
      else lane.queue.push(job);
    } else {
      if (lane.queue.length >= OBSERVE_QUEUE_LIMIT) lane.queue.shift();
      lane.queue.push(job);
    }
    if (lane.running) return;
    lane.running = true;
    void this.drainObserve(id, input.event, lane, key);
  }

  private async drainObserve(
    id: string,
    event: PluginEventName,
    lane: ObserveLane,
    key: string
  ): Promise<void> {
    while (true) {
      const job = lane.queue.shift();
      if (!job) {
        lane.running = false;
        if (this.observeLanes.get(key) === lane) this.observeLanes.delete(key);
        return;
      }
      if (this.isDisposed || !this.canDeliverObserve(id)) continue;
      try {
        await this.invoke(
          id,
          'event.dispatch',
          { event, data: job.data },
          {
            sessionId: job.sessionId,
            projectRoot: job.projectRoot,
            gesture: false,
            timeoutMs: OBSERVE_TIMEOUT_MS,
            kind: 'event',
            ...(job.agent ? { agent: job.agent } : {}),
          }
        );
      } catch (error) {
        this.appendLog(
          id,
          'warn',
          `事件 ${event} 失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private invalidatePackageCache(id: string): void {
    const prefix = `${id}/`;
    for (const key of this.loaded.keys()) if (key.startsWith(prefix)) this.loaded.delete(key);
    for (const key of this.textCache.keys()) if (key.startsWith(prefix)) this.textCache.delete(key);
    for (const key of this.configCache.keys())
      if (key.startsWith(prefix)) this.configCache.delete(key);
  }

  private readText(
    id: string,
    dir: string,
    rel: string
  ): { ok: true; content: string } | { ok: false } {
    const key = `${id}/${dir}/${rel}`;
    const cached = this.textCache.get(key);
    if (cached) return cached;
    const result = readPluginText(pluginPackagePath(this.options.root, id, dir), rel);
    this.textCache.set(key, result);
    return result;
  }
}

class TrackedPluginProcess extends PluginProcess {
  constructor(
    deps: ConstructorParameters<typeof PluginProcess>[0],
    private readonly remember: (pending: Promise<unknown>) => void
  ) {
    super(deps);
  }

  override ready(): ReturnType<PluginProcess['ready']> {
    const pending = super.ready();
    this.remember(pending);
    return pending;
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

const scheduleKey = (pluginId: string, id: string) => `${pluginId}\n${id}`;

const observeLaneKey = (
  id: string,
  input: { sessionId: string; event: PluginEventName; agent?: PluginAgentSource }
) => {
  const agent = input.agent
    ? `${input.agent.kind}\0${input.agent.sessionId}\0${input.agent.name}`
    : '';
  return `${id}\0${input.event}\0${input.sessionId}\0${agent}`;
};

/** 基础环境加上清单声明的变量；未声明的（包括密钥）不透传 */
export function pluginProcessEnv(
  base: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv | undefined,
  declared: readonly string[]
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (!source) return env;
  for (const name of declared) if (source[name] !== undefined) env[name] = source[name];
  return env;
}

function createProgressTap(emit: (text: string) => void, now: () => number = Date.now) {
  let last = Number.NEGATIVE_INFINITY;
  return (text: string) => {
    const at = now();
    if (at - last < PROGRESS_INTERVAL_MS) return;
    last = at;
    emit(text.slice(0, PLUGIN_PROGRESS_MAX_CHARS));
  };
}

function configMatches(field: PluginConfigContrib, value: ConfigValue): boolean {
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (field.type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string';
}

function coerceConfig(
  field: PluginConfigContrib,
  value: string | number | boolean
): ConfigValue | { error: string } {
  if (field.type === 'number') {
    const numeric =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())
          ? Number(value.trim())
          : Number.NaN;
    if (!Number.isFinite(numeric)) return { error: `配置项 ${field.key} 需要数字` };
    if (field.min !== undefined && numeric < field.min)
      return { error: `配置项 ${field.key} 小于最小值` };
    if (field.max !== undefined && numeric > field.max)
      return { error: `配置项 ${field.key} 大于最大值` };
    return numeric;
  }
  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return { error: `配置项 ${field.key} 需要布尔值` };
  }
  if (typeof value !== 'string' || value.length > MAX_CONFIG_VALUE_CHARS)
    return { error: `配置项 ${field.key} 不合法或过长` };
  if (field.type === 'enum' && !field.options?.includes(value))
    return { error: `配置项 ${field.key} 不在可选项里` };
  return value;
}

function interceptsTool(sub: { tools?: string[] }, payload: unknown): boolean {
  if (!sub.tools) return true;
  if (typeof payload !== 'object' || payload === null) return true;
  const toolName = (payload as { toolName?: unknown }).toolName;
  return typeof toolName === 'string' ? sub.tools.includes(toolName) : true;
}

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
