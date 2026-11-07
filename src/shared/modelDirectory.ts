/**
 * 统一模型目录（Model Directory）——「有哪些模型」的唯一权威源。
 *
 * 背景：模型清单曾经四处复制（登录时冻结进 settings.json、worker 内存注册表、
 * 各 provider 模块级发现缓存），快照各自腐化（典型事故：静态表新增的
 * gemini-3.8-flash 永远进不了老账号的 settings.json）。本模块把清单降级为
 * 派生数据：Main 合成快照，Renderer / Worker 订阅；settings.json 里的
 * OAuth 条目只保留**稀疏覆盖表**（用户意图：禁用、别名、能力覆盖、选型引用）。
 *
 * 与 ./modelCatalog 的分工：那边管「单个模型的能力分层解析」，这边管
 * 「全部模型的清单与物化」。名字相近是有意的——能力解析是本目录的消费者。
 */

import { pickModelCapabilityOverrides } from './modelCatalog';
import type { ModelEntry, ModelProvider } from './types/llm';
import { providerIdOfAccountKey } from './types/oauthProviders';

/** 目录中的一个模型条目。能力元数据走 modelMeta 通道，这里只有身份与展示名。 */
export interface DirectoryModel {
  id: string;
  label?: string;
}

/**
 * 目录分区。key：OAuth 分区 = 基础 providerId（'google-antigravity'，多账号共享）；
 * 自定义分区 = settings 条目 id。
 */
export interface DirectoryProvider {
  key: string;
  kind: 'oauth' | 'custom';
  label: string;
  models: DirectoryModel[];
  /** 最近一次动态发现成功的 epoch ms；纯静态/自定义分区缺省 */
  discoveredAt?: number;
}

export interface ModelDirectorySnapshot {
  /** 单调递增；Renderer / Worker 据此丢弃晚到的旧快照 */
  revision: number;
  generatedAt: number;
  providers: DirectoryProvider[];
}

/**
 * 从（可能稠密的）models 数组提取稀疏覆盖表：只留携带用户意图的行
 * （禁用 / 别名 / 能力覆盖 / referencedIds 中的选型引用）。没有选型引用的
 * `{id}` 与 `{id, enabled: true}` 是登录时冻结拷贝的产物，丢弃。
 * 非法覆盖字段沿用 pickModelCapabilityOverrides
 * 口径，不构成意图。
 *
 * 传入 `baseline`（目录分区）时，与目录 label 相同的 label 不算意图——
 * 物化视图会把目录 label 注入每一行，编辑保存往返若不比基线，稀疏表会被
 * 目录事实重新膨胀成稠密拷贝。
 */
export function extractModelOverrides(
  entries: readonly ModelEntry[],
  baseline?: readonly DirectoryModel[],
  referencedIds?: ReadonlySet<string>
): ModelEntry[] {
  const baselineLabels = baseline
    ? new Map(baseline.map((model) => [model.id, model.label]))
    : undefined;
  const kept: ModelEntry[] = [];
  for (const entry of entries) {
    const labelIsIntent =
      typeof entry.label === 'string' &&
      entry.label.length > 0 &&
      baselineLabels?.get(entry.id) !== entry.label;
    const hasIntent =
      // 被选型引用的 {id} 是用户选择，不是冻结目录；编辑再次保存也不能丢。
      referencedIds?.has(entry.id) ||
      entry.enabled === false ||
      entry.imageGeneration === true ||
      labelIsIntent ||
      Object.keys(pickModelCapabilityOverrides(entry)).length > 0;
    if (hasIntent) {
      const row = { ...entry };
      // 行被保留但与目录同名的 label 是冗余拷贝，剥掉（物化时会重新注入）
      if (!labelIsIntent && baselineLabels !== undefined) delete row.label;
      // enabled:true 与缺省等价，剥掉冗余（稀疏表只记 enabled:false）
      if (row.enabled === true) delete row.enabled;
      kept.push(row);
    }
  }
  return kept;
}

/** 只读设置中的选型位；按条目 id 隔离账号，不把 provider 全量 models 当引用。 */
export function referencedModelIds(settings: unknown, providerId: unknown): Set<string> {
  const ids = new Set<string>();
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const add = (value: unknown) => {
    const ref = record(value);
    if (
      typeof providerId === 'string' &&
      ref.providerId === providerId &&
      typeof ref.modelId === 'string' &&
      ref.modelId
    ) {
      ids.add(ref.modelId);
    }
  };
  const state = record(settings);
  for (const key of [
    'defaultModel',
    'imageGenerationModel',
    'titleSummaryModel',
    'approvalReviewer',
    'smartCompactModel',
    'memoryDistillModel',
    'voiceCorrectionRemoteModel',
    'botAssistantModel',
  ])
    add(state[key]);
  for (const item of [...list(state.projects), ...list(state.projectGroups)])
    add(record(item).defaultModel);
  for (const item of [...list(state.subagentModels), ...list(state.agentTypes)]) add(item);
  for (const item of list(state.virtualModels)) {
    const model = record(item);
    add(model.primary);
    add(model.fast);
    for (const fallback of list(model.fallbacks)) add(fallback);
    add(record(model.classifier).model);
  }
  add(record(state.botRouteClassifier).model);
  return ids;
}

/**
 * 目录清单 + 稀疏覆盖 → 消费方期待的 ModelEntry[] 物化视图。
 *
 * - `directory === undefined`：原样返回覆盖数组（旧稠密拷贝 / 目录未就绪兜底）。
 * - 目录顺序为权威；覆盖行按 id 合入（label/enabled/能力覆盖，覆盖优先）。
 * - 覆盖行里目录已不含的 id 追加在末尾：模型下线不应让用户的选型引用凭空消失。
 * - 旧稠密拷贝同样适用：逐 id 合并后输出与目录同形，迁移前数据行为不变。
 */
export function materializeOAuthModels(
  directory: readonly DirectoryModel[] | undefined,
  overrides: readonly ModelEntry[]
): ModelEntry[] {
  if (directory === undefined) return overrides.map((entry) => ({ ...entry }));
  const byId = new Map(overrides.map((entry) => [entry.id, entry]));
  const out: ModelEntry[] = [];
  for (const model of directory) {
    const override = byId.get(model.id);
    byId.delete(model.id);
    const entry: ModelEntry = { id: model.id };
    if (model.label !== undefined) entry.label = model.label;
    if (override) {
      if (override.label !== undefined) entry.label = override.label;
      if (override.enabled !== undefined) entry.enabled = override.enabled;
      if (override.imageGeneration !== undefined) entry.imageGeneration = override.imageGeneration;
      Object.assign(entry, pickModelCapabilityOverrides(override));
    }
    out.push(entry);
  }
  for (const rest of byId.values()) out.push({ ...rest });
  return out;
}

/** 按 OAuth 账号 key（含 `provider#n` 合成 key）找目录分区。 */
export function directorySectionForAccount(
  directory: ModelDirectorySnapshot | undefined,
  accountKey: string
): DirectoryProvider | undefined {
  return directory?.providers.find((section) => section.key === providerIdOfAccountKey(accountKey));
}

/**
 * 把 settings.providers 物化成消费方（picker / 校验）使用的视图：
 * 自定义条目原样透传；OAuth 条目的 models 换成「目录 + 覆盖」的合成结果。
 * 目录整体缺失或分区未命中时该条目原样透传——任何时刻行为不劣于旧路径。
 */
export function materializeProviders(
  providers: readonly ModelProvider[],
  directory: ModelDirectorySnapshot | undefined
): ModelProvider[] {
  if (!directory) return [...providers];
  const byKey = new Map(directory.providers.map((provider) => [provider.key, provider]));
  return providers.map((provider) => {
    if (!provider.oauthAccountKey) return provider;
    const section = byKey.get(providerIdOfAccountKey(provider.oauthAccountKey));
    if (!section) return provider;
    return { ...provider, models: materializeOAuthModels(section.models, provider.models) };
  });
}

/** IPC / 磁盘来的快照一律按 unknown 收窄；坏条目逐个剔除，好的保留。 */
export function parseModelDirectorySnapshot(value: unknown): ModelDirectorySnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.revision !== 'number' || !Number.isFinite(raw.revision)) return undefined;
  if (typeof raw.generatedAt !== 'number' || !Number.isFinite(raw.generatedAt)) return undefined;
  if (!Array.isArray(raw.providers)) return undefined;
  const providers: DirectoryProvider[] = [];
  for (const item of raw.providers) {
    const parsed = parseDirectoryProvider(item);
    if (parsed) providers.push(parsed);
  }
  return { revision: raw.revision, generatedAt: raw.generatedAt, providers };
}

function parseDirectoryProvider(value: unknown): DirectoryProvider | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.key !== 'string' || raw.key.length === 0) return undefined;
  if (raw.kind !== 'oauth' && raw.kind !== 'custom') return undefined;
  if (typeof raw.label !== 'string') return undefined;
  if (!Array.isArray(raw.models)) return undefined;
  const models: DirectoryModel[] = [];
  for (const item of raw.models) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue;
    const model: DirectoryModel = { id: entry.id };
    if (typeof entry.label === 'string' && entry.label.length > 0) model.label = entry.label;
    models.push(model);
  }
  const provider: DirectoryProvider = { key: raw.key, kind: raw.kind, label: raw.label, models };
  if (typeof raw.discoveredAt === 'number' && Number.isFinite(raw.discoveredAt)) {
    provider.discoveredAt = raw.discoveredAt;
  }
  return provider;
}
