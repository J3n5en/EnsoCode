import { pickModelCapabilityOverrides, resolveCustomModelView } from '@shared/modelCatalog';
import { clampProjectThinkingLevel, visibleThinkingLevels } from '@shared/modelThinking';
import { CUSTOM_VENDOR_ID, groupProviders, type ProviderGroup } from '@shared/providerGroups';
import type {
  ModelCapabilityOverrides,
  ModelEntry,
  ModelMeta,
  ModelProvider,
  OauthProviderInfo,
} from '@shared/types';
import { THINKING_LEVELS, type ThinkingLevel } from '@shared/types/agent';
import {
  findVirtualModel,
  selectableVirtualModels,
  VIRTUAL_PROVIDER_ID,
  type VirtualModelEntry,
} from '@shared/virtualModels';
import { Brain, Check, ChevronDown, Loader2, RefreshCw, Shuffle, Star } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { providerDisplayName } from '@/components/settings/chatgptPool';
import { applyFetchedModels, fetchAllProviderModels } from '@/components/settings/providerFetch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { Switch } from '@/components/ui/switch';
import { prefetchAccountUsage, useCachedAccountUsage } from '@/hooks/useAccountUsage';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { invalidateModelMeta, useModelMeta } from '@/stores/modelMeta';
import { formatTokens } from '@/stores/sessions/stats';
import { useSettingsStore } from '@/stores/settings';
import { interceptRootCascadeEscape } from './modelPickerCascadeEsc';
import { type SessionUsageAccount, usageAccountKeyForProvider } from './sessionUsageAccount';

export const OPEN_CHAT_MODEL_PICKER_EVENT = 'enso:open-chat-model-picker';

/** 表单/设置里的整行下拉触发器 */
export const MODEL_PICKER_FORM_TRIGGER_CLASS =
  'h-8 w-full max-w-none border border-input bg-background px-2.5 text-sm text-foreground hover:bg-accent';

export function requestOpenChatModelPicker() {
  window.dispatchEvent(new Event(OPEN_CHAT_MODEL_PICKER_EVENT));
}

export type ModelPickerNavTarget =
  | { readonly kind: 'favorites' }
  | { readonly kind: 'vendor'; readonly vendorId: string };

export function pinnedModelKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

function providerInGroup(
  group: ProviderGroup,
  providerId: string | undefined
): ModelProvider | undefined {
  if (!providerId) return undefined;
  return group.providers.find((provider) => provider.id === providerId);
}

function activeProviderForGroup(
  group: ProviderGroup,
  selectedProviderId: string,
  activeProviderByVendor: Readonly<Record<string, string>> | undefined
): ModelProvider | undefined {
  return (
    providerInGroup(group, activeProviderByVendor?.[group.vendorId]) ??
    providerInGroup(group, selectedProviderId) ??
    group.providers[0]
  );
}

export function expandWorkbenchGroups(groups: readonly ProviderGroup[]): ProviderGroup[] {
  const out: ProviderGroup[] = [];
  for (const group of groups) {
    if (group.vendorId !== CUSTOM_VENDOR_ID) {
      out.push(group);
      continue;
    }
    for (const provider of group.providers) {
      out.push({
        vendorId: `${CUSTOM_VENDOR_ID}:${provider.id}`,
        label: provider.name,
        providers: [provider],
      });
    }
  }
  return out;
}

export function resolveActiveWorkbenchView(options: {
  groups: readonly ProviderGroup[];
  selectableVirtualModels: readonly VirtualModelEntry[];
  pinnedCount: number;
  selectedProviderId: string;
  activeNav: ModelPickerNavTarget | null;
  activeProviderByVendor?: Readonly<Record<string, string>>;
}): {
  activeNav: ModelPickerNavTarget;
  activeGroup: ProviderGroup | undefined;
  activeProvider: ModelProvider | undefined;
  showFavoritesNav: boolean;
} {
  const showFavoritesNav = options.selectableVirtualModels.length > 0 || options.pinnedCount > 0;
  const favorites = {
    activeNav: { kind: 'favorites' } as const,
    activeGroup: undefined,
    activeProvider: undefined,
    showFavoritesNav,
  };
  const explicit = options.activeNav;
  if (explicit?.kind === 'favorites' && showFavoritesNav) return favorites;
  if (explicit?.kind === 'vendor') {
    const group = options.groups.find((entry) => entry.vendorId === explicit.vendorId);
    if (group) {
      return {
        activeNav: { kind: 'vendor', vendorId: group.vendorId },
        activeGroup: group,
        activeProvider: activeProviderForGroup(
          group,
          options.selectedProviderId,
          options.activeProviderByVendor
        ),
        showFavoritesNav,
      };
    }
  }

  if (
    options.selectedProviderId === VIRTUAL_PROVIDER_ID &&
    options.selectableVirtualModels.length > 0
  ) {
    return favorites;
  }
  const selectedGroup = options.groups.find((group) =>
    group.providers.some((provider) => provider.id === options.selectedProviderId)
  );
  const vendorId = selectedGroup
    ? selectedGroup.vendorId
    : showFavoritesNav
      ? undefined
      : options.groups[0]?.vendorId;
  if (!vendorId) return favorites;
  const activeGroup = options.groups.find((group) => group.vendorId === vendorId);
  return {
    activeNav: { kind: 'vendor', vendorId },
    activeGroup,
    activeProvider: activeGroup
      ? activeProviderForGroup(
          activeGroup,
          options.selectedProviderId,
          options.activeProviderByVendor
        )
      : undefined,
    showFavoritesNav,
  };
}

/** catalog 未声明支持集时只改展示，不回写。 */
export function persistClampedThinkingLevel(
  level: ThinkingLevel,
  declared: ThinkingLevel[] | undefined
): ThinkingLevel | undefined {
  const next = clampProjectThinkingLevel(level, declared);
  return next === level ? undefined : next;
}

/** 展示复用运行时能力分层；乐观默认可以预览，但不能当成已知支持集回写。 */
export function resolvePickerCapabilities(
  provider: ModelProvider | undefined,
  row: ModelEntry | undefined,
  meta: ModelMeta | undefined,
  overrides?: ModelCapabilityOverrides
): {
  reasoning: boolean | undefined;
  thinkingLevels: ThinkingLevel[] | undefined;
  declaredThinkingLevels: ThinkingLevel[] | undefined;
} {
  const knownMeta = meta?.source === 'unknown' ? undefined : meta;
  if (provider?.oauthAccountKey) {
    return {
      reasoning: knownMeta?.reasoning,
      thinkingLevels: knownMeta?.thinkingLevels,
      declaredThinkingLevels: knownMeta?.thinkingLevels,
    };
  }
  const view = resolveCustomModelView({ ...row, ...pickModelCapabilityOverrides(overrides) }, meta);
  // 子模型的深度是可编辑覆盖，不是不可突破的模型能力上限；选低档不能删掉更高档入口。
  if (overrides !== undefined) {
    return {
      reasoning: view.reasoning,
      thinkingLevels: [...THINKING_LEVELS],
      declaredThinkingLevels: undefined,
    };
  }
  return {
    reasoning: view.reasoning,
    thinkingLevels: view.thinkingLevels,
    declaredThinkingLevels:
      view.source.thinkingLevel === 'override' || knownMeta?.thinkingLevels !== undefined
        ? view.thinkingLevels
        : undefined,
  };
}

/** 档位显示文案的 t() key（不是已翻译文本）；沿用既有英文短词，字典里已配好中文译文 */
const LEVEL_LABEL_KEYS: Record<ThinkingLevel, string> = {
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'Extra',
  max: 'Max',
};

/**
 * 账号身份数据来自厂商侧（外部输入），渲染前在解析边界做防御性兜底：剔除控制字符
 * （避免破坏渲染/布局），超长截断（避免撑破固定宽度的级联菜单，配合渲染侧的 max-w+truncate
 * 双重兜底，不是互相替代）。
 */
function sanitizeAccountText(value: string, maxLength: number): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  out = out.trim();
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

/**
 * 单个条目超过这个模型数时，二级子菜单顶部出现局部过滤框。
 * 依据：子菜单高度上限 `max-h-64`(16rem/256px)，单行约 32px，约能容纳 8 行不滚动、
 * 加余量到约 12-15 行仍算"一眼扫得完"；超过 20 条基本必然要滚动，线性翻找体验开始变差，
 * 这时给一个局部过滤框比继续滚动更划算。⚠️ 与顶部跨条目全局搜索是两回事，互不干扰。
 */
const SUBMENU_FILTER_THRESHOLD = 20;

/** 同一条目内展示名（label ?? id）重复的已启用模型；这些行需附 id 才能区分（如 Cursor 上游重名）。 */
export function duplicateModelLabels(models: readonly ModelEntry[]): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const model of models) {
    if (model.enabled === false) continue;
    const name = model.label ?? model.id;
    if (seen.has(name)) duplicated.add(name);
    else seen.add(name);
  }
  return duplicated;
}

/**
 * base-ui Menu 在弹层打开时会把方向键/回车/Esc 当菜单导航、把可打印字符当 typeahead 处理——
 * 后者会在 keydown 阶段抢先 `preventDefault()`，导致弹层内任何 `<input>`（顶部全局搜索框、
 * 二级子菜单过滤框）完全打不进字。修法是只拦截"会被当 typeahead 吞掉"的按键，方向键/回车/Esc/Tab
 * 仍放行冒泡给 Menu 的根级键盘处理器——这样搜索/过滤框能正常打字，同时不破坏原生的方向键选中、
 * 右键进子菜单、回车确认、Esc 逐级退出（这正是选级联 Menu 组件而不是手写两栏的收益，不能丢）。
 */
const MENU_NAV_KEYS: Record<string, true> = {
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  Enter: true,
  Escape: true,
  Tab: true,
};

function stopTypeaheadOnly(e: KeyboardEvent<HTMLInputElement>): void {
  if (!MENU_NAV_KEYS[e.key]) e.stopPropagation();
}

interface ModelPickerProps {
  providers: ModelProvider[];
  /** 传入时在顶部列出可选虚拟模型 */
  virtualModels?: readonly VirtualModelEntry[];
  /** 选中虚拟模型时附在触发器上的实际路由模型 */
  routedModelLabel?: string;
  /** 当前会话真实请求的订阅账号；设置场景不传，池额度保持隐藏。 */
  activeAccount?: SessionUsageAccount;
  providerId: string;
  modelId: string;
  reasoningEnabled: boolean;
  thinkingLevel: ThinkingLevel;
  /** 子模型三态；不传时保留主会话的二态开关。 */
  reasoningMode?: 'follow' | 'on' | 'off';
  onReasoningModeChange?: (mode: 'follow' | 'on' | 'off', level: ThinkingLevel) => void;
  /** 仅当前选中自定义模型的条目覆盖；OAuth 能力仍以 catalog 为准。 */
  modelCapabilityOverrides?: ModelCapabilityOverrides;
  /** 仅需 provider/account/model 级联的场景可隐藏 reasoning/thinking。 */
  showReasoningControls?: boolean;
  /** 仅会话工具行：响应全局「切换模型」快捷键并聚焦搜索框 */
  listenHotkey?: boolean;
  /** 仅会话工具行：弹层顶部显示刷新 icon，一次拉取全部模型与模型信息 */
  refreshAllModels?: boolean;
  onSelect: (providerId: string, modelId: string) => void;
  onReasoningChange: (enabled: boolean) => void;
  onThinkingChange: (level: ThinkingLevel) => void;
  /** 模型能力约束触发的自动归一化；缺省复用用户变更回调。 */
  onReasoningNormalize?: (enabled: boolean) => void;
  onThinkingNormalize?: (level: ThinkingLevel) => void;
  /** 弹层层级；对话框内须高于模态层 */
  zIndex?: number;
  /** 未选模型时触发器文案 */
  emptyLabel?: string;
  /** 覆盖触发器文案；设置页「跟随上次选择」等不显示具体模型名 */
  triggerLabel?: string;
  triggerClassName?: string;
  side?: 'top' | 'bottom';
}

/**
 * 子序列模糊匹配打分：query 的字符必须按顺序（不要求连续）出现在 target 里，
 * 全部命中才算命中，否则返回 null（不显示）。打分口径（越高越靠前排）：
 * - 每个命中字符 +1；
 * - 与上一个命中字符紧邻（连续片段）额外 +3——让连续子串盖过分散命中；
 * - 命中位置在词首或紧跟 `-_. /` 分隔符之后 +2——贴近人类感知的“单词边界”；
 * - 首个命中位置越靠后扣分越多（扣分 = 首位置 * 0.1）——越靠前的匹配更符合直觉。
 */
function fuzzyMatchScore(query: string, target: string): number | null {
  if (!query) return 0;
  if (!target) return null;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  let firstMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    if (firstMatch === -1) firstMatch = ti;
    score += 1;
    if (lastMatch === ti - 1) score += 3;
    if (ti === 0 || /[-_. /]/.test(t[ti - 1])) score += 2;
    lastMatch = ti;
    qi++;
  }
  if (qi < q.length) return null;
  return score - firstMatch * 0.1;
}

/** 多字段取最高（加权）分；模型 id/label 权重高于条目/厂商名，避免"名字撞了但模型不对"排到前面 */
function bestFieldScore(
  query: string,
  fields: readonly (readonly [text: string, weight: number])[]
): number | null {
  let best: number | null = null;
  for (const [text, weight] of fields) {
    if (!text) continue;
    const score = fuzzyMatchScore(query, text);
    if (score === null) continue;
    const weighted = score * weight;
    if (best === null || weighted > best) best = weighted;
  }
  return best;
}

/** 挂载即向 onData 上报该 provider 的模型元数据；用于在弹层里为多个 provider 并发订阅 useModelMeta */
function ModelMetaBridge({
  provider,
  onData,
}: {
  provider: ModelProvider;
  onData: (providerId: string, meta: Record<string, ModelMeta>) => void;
}) {
  const meta = useModelMeta(provider);
  useEffect(() => {
    onData(provider.id, meta);
  }, [provider.id, meta, onData]);
  return null;
}

function ModelPinButton({
  pin,
}: {
  pin: { key: string; pinned: boolean; onToggle: (key: string) => void };
}) {
  return (
    <button
      type="button"
      data-model-pin={pin.key}
      aria-pressed={pin.pinned}
      onClick={(event) => {
        event.stopPropagation();
        pin.onToggle(pin.key);
      }}
    >
      <Star
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          pin.pinned ? 'fill-current text-primary' : 'text-muted-foreground/60'
        )}
      />
    </button>
  );
}

function ModelRowContent({
  model,
  meta,
  entryTag,
  selected,
  showId,
  pin,
}: {
  model: ModelEntry;
  meta: ModelMeta | undefined;
  entryTag?: string;
  selected: boolean;
  showId?: boolean;
  pin?: {
    key: string;
    pinned: boolean;
    onToggle: (key: string) => void;
  };
}) {
  const { t } = useI18n();
  // 行覆盖（ModelEntry.contextWindow，含 Fetch Models 落地的元数据）优先于 catalog；
  // 与设置页 ProviderModelRow 同一套分层，不另写一份判定。
  const view = resolveCustomModelView(model, meta);
  const windowTokens = view.contextWindow;
  const estimated =
    windowTokens !== undefined &&
    view.source.contextWindow === 'catalog' &&
    meta?.source === 'catalog-fallback';
  const name = model.label ?? model.id;
  return (
    <>
      {pin && <ModelPinButton pin={pin} />}
      {showId ? (
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
          <span className="shrink-0 truncate" title={name}>
            {name}
          </span>
          <span
            data-model-row-id={model.id}
            title={model.id}
            className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/70"
          >
            {model.id}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate" title={name}>
          {name}
        </span>
      )}
      {entryTag && (
        <span className="shrink-0 truncate text-[10px] text-muted-foreground/60" title={entryTag}>
          {entryTag}
        </span>
      )}
      {windowTokens !== undefined && (
        <span
          className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
          title={estimated ? t('Estimated context window (catalog fallback)') : t('Context window')}
        >
          {formatTokens(windowTokens)}
          {estimated ? '*' : ''}
        </span>
      )}
      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
    </>
  );
}

/**
 * 一个供应商「条目」（订阅账号或 API-key 配置）在菜单里的展示名。
 * 读法与设置页 `ProvidersSettings.tsx` 同款口径对齐（同一套账号信息，不让用户学两遍）：
 * 订阅条目主位放账号身份——邮箱优先，没有邮箱退回账号 key，都没有才退回 provider.name
 * （厂商名已经是分组标题，不重复放主位）；`plan` 单独返回供调用方渲染成徽标。
 * API-key 条目主位仍是 `provider.name`（用户自定义命名本身就是区分信息），host 当副标题。
 */
function entryLabelOf(
  provider: ModelProvider,
  oauthAccountsByKey: Record<string, { email?: string; plan?: string }>,
  t: (key: string) => string
): { primary: string; secondary?: string; plan?: string; isSubscription: boolean } {
  if (provider.oauthAccountPool) {
    return { primary: providerDisplayName(provider, t), isSubscription: true };
  }
  if (provider.oauthAccountKey) {
    const account = oauthAccountsByKey[provider.oauthAccountKey];
    const email = account?.email ? sanitizeAccountText(account.email, 64) : undefined;
    const plan = account?.plan ? sanitizeAccountText(account.plan, 16) : undefined;
    return {
      primary: email || provider.oauthAccountKey || provider.name,
      plan,
      isSubscription: true,
    };
  }
  let host: string | undefined;
  try {
    host = new URL(provider.baseUrl).hostname;
  } catch {
    host = undefined;
  }
  return { primary: provider.name, secondary: host, isSubscription: false };
}

/**
 * 二级子菜单的模型列表：固定高度上限 + 内部滚动；条目模型数超过 `SUBMENU_FILTER_THRESHOLD`
 * 时顶部加一个只收窄本条目的局部过滤框，并在底部标"显示 N / 共 M"。
 * ⚠️ 局部过滤 state 是这个组件自己的（每个 provider 条目独立一份），不与顶部跨条目全局搜索共享。
 * 过滤框故意不做"子菜单打开即自动 focus"：那样会抢走 base-ui Menu 原生落在子菜单第一项上的
 * 方向键导航焦点——键盘可达是选级联 Menu 组件的主要收益之一，不能丢；用户想用过滤框时点一下
 * 即可。`onKeyDown` 仍然要接 `stopTypeaheadOnly`（只拦可打印字符，放行方向键/回车/Esc），
 * 否则 Menu 的 typeahead 会吞掉这个输入框的按键（和顶部搜索框同一个坑，同一个修法）。
 */
function ProviderSubmenuList({
  provider,
  meta,
  selectedProviderId,
  selectedModelId,
  pinnedKeys,
  onTogglePin,
  onSelectModel,
}: {
  provider: ModelProvider;
  meta: Record<string, ModelMeta> | undefined;
  selectedProviderId: string;
  selectedModelId: string;
  pinnedKeys: ReadonlySet<string>;
  onTogglePin: (key: string) => void;
  onSelectModel: (modelId: string) => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const enabledModels = useMemo(
    () => provider.models.filter((m) => m.enabled !== false),
    [provider.models]
  );
  const duplicatedLabels = useMemo(() => duplicateModelLabels(enabledModels), [enabledModels]);
  const showFilter = enabledModels.length > SUBMENU_FILTER_THRESHOLD;
  const visibleModels = useMemo(() => {
    if (!showFilter || !filter.trim()) return enabledModels;
    const q = filter.trim();
    return enabledModels
      .map((model) => ({
        model,
        score: bestFieldScore(q, [
          [model.id, 1],
          [model.label ?? '', 1],
        ]),
      }))
      .filter((entry): entry is { model: ModelEntry; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.model);
  }, [showFilter, filter, enabledModels]);

  return (
    <>
      {showFilter && (
        <div className="mb-1 flex shrink-0 items-center gap-1.5 border-b pb-1">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={stopTypeaheadOnly}
            placeholder={t('Filter models in this entry')}
            className="h-6 min-w-0 flex-1 rounded border bg-transparent px-2 text-[11px] outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
            {visibleModels.length}/{enabledModels.length}
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleModels.map((model) => {
          const key = pinnedModelKey(provider.id, model.id);
          return (
            <MenuItem
              key={model.id}
              className="min-h-6 gap-1.5 px-1.5 py-0.5 text-xs sm:min-h-6 sm:text-xs"
              onClick={() => onSelectModel(model.id)}
            >
              <ModelRowContent
                model={model}
                meta={meta?.[model.id]}
                showId={duplicatedLabels.has(model.label ?? model.id)}
                selected={provider.id === selectedProviderId && model.id === selectedModelId}
                pin={{ key, pinned: pinnedKeys.has(key), onToggle: onTogglePin }}
              />
            </MenuItem>
          );
        })}
        {visibleModels.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            {t('No models found')}
          </p>
        )}
      </div>
    </>
  );
}

/** 订阅条目子菜单顶部的额度块：子菜单展开时才拉取（60s 共享缓存）；无数据/出错静默隐藏 */
function SubmenuUsage({ accountKey }: { accountKey: string }) {
  const { t } = useI18n();
  const info = useCachedAccountUsage(accountKey);
  if (!info || info.error || info.windows.length === 0) return null;
  return (
    <div className="mb-1 shrink-0 space-y-0.5 border-b px-1.5 pb-1">
      {info.windows.map((windowInfo) => (
        <div key={windowInfo.label} className="flex min-w-0 items-center gap-2 text-[10px]">
          <span className="w-8 shrink-0 truncate text-muted-foreground" title={windowInfo.label}>
            {windowInfo.label}
          </span>
          <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${Math.max(0, Math.min(100, windowInfo.usedPercent))}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
            {Math.round(windowInfo.usedPercent)}%
          </span>
          {windowInfo.resetsAt !== undefined && (
            <span className="min-w-0 truncate text-muted-foreground/60">
              {t('Resets {{time}}', {
                time: new Date(windowInfo.resetsAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

interface SearchHit {
  provider: ModelProvider;
  model: ModelEntry;
  entryTag: string;
  showId: boolean;
  score: number;
}

/** composer 工具行的模型选择。 */
export function ModelPicker({
  providers,
  virtualModels,
  routedModelLabel,
  activeAccount,
  providerId,
  modelId,
  reasoningEnabled,
  thinkingLevel,
  modelCapabilityOverrides,
  reasoningMode,
  onReasoningModeChange,
  showReasoningControls = true,
  listenHotkey = false,
  refreshAllModels = false,
  onSelect,
  onReasoningChange,
  onThinkingChange,
  onReasoningNormalize,
  onThinkingNormalize,
  zIndex,
  emptyLabel,
  triggerLabel: triggerLabelProp,
  triggerClassName,
  side = 'top',
}: ModelPickerProps) {
  const { t } = useI18n();
  const normalizeReasoning = onReasoningNormalize ?? onReasoningChange;
  const normalizeThinking = onThinkingNormalize ?? onThinkingChange;
  const reasoningInherited = reasoningMode === 'follow';
  const thinkingInherited = reasoningMode !== undefined && !modelCapabilityOverrides?.thinkingLevel;
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const pinnedModels = useSettingsStore((s) => s.pinnedModels);
  const handleTogglePin = useSettingsStore((s) => s.togglePinnedModel);
  const allProviders = useSettingsStore((s) => s.providers);
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const [refreshingAll, setRefreshingAll] = useState(false);
  /** 先刷模型信息（统一目录），再按条目拉取全部模型清单：订阅条目的重拉依赖新目录。 */
  const refreshAll = useCallback(async () => {
    setRefreshingAll(true);
    try {
      await window.electronAPI.providers.refreshModelCatalog();
      invalidateModelMeta();
      applyFetchedModels(await fetchAllProviderModels(allProviders), updateProvider);
    } catch {
      // 失败时保留旧清单，不做额外提示
    } finally {
      setRefreshingAll(false);
    }
  }, [allProviders, updateProvider]);
  const pinnedKeys = useMemo(() => new Set(pinnedModels), [pinnedModels]);
  const [activeNav, setActiveNav] = useState<ModelPickerNavTarget | null>(null);
  const [activeProviderByVendor, setActiveProviderByVendor] = useState<
    Readonly<Record<string, string>>
  >({});
  const openSubmenuIdsRef = useRef(new Set<string>());
  const searchFocusedRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingSearchFocusRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const [oauthInfos, setOauthInfos] = useState<OauthProviderInfo[]>([]);
  const [metaByProvider, setMetaByProvider] = useState<Record<string, Record<string, ModelMeta>>>(
    {}
  );

  const visibleVirtualModels = useMemo(
    () => selectableVirtualModels(virtualModels, providers),
    [virtualModels, providers]
  );
  const currentVirtual = findVirtualModel(virtualModels, { providerId, modelId });
  // 虚拟模型的推理能力按主模型展示与钳位
  const capabilityRef = currentVirtual?.primary ?? { providerId, modelId };
  const currentProvider = useMemo(
    () => providers.find((p) => p.id === capabilityRef.providerId),
    [providers, capabilityRef.providerId]
  );
  const current = currentProvider?.models.find((m) => m.id === capabilityRef.modelId);
  const formTrigger = Boolean(triggerClassName);
  const modelName = currentVirtual
    ? routedModelLabel
      ? `${currentVirtual.name} · ${routedModelLabel}`
      : currentVirtual.name
    : current?.label || current?.id || modelId;
  const hasSelection = Boolean(modelName);
  const triggerLabel =
    triggerLabelProp ??
    (hasSelection
      ? (formTrigger || currentProvider?.oauthAccountPool) &&
        currentProvider?.name &&
        !currentVirtual
        ? `${providerDisplayName(currentProvider, t)} / ${modelName}`
        : modelName
      : emptyLabel || t('Select model'));

  const groups = useMemo(
    () => expandWorkbenchGroups(groupProviders(providers, oauthInfos)),
    [providers, oauthInfos]
  );
  const view = useMemo(
    () =>
      resolveActiveWorkbenchView({
        groups,
        selectableVirtualModels: visibleVirtualModels,
        pinnedCount: pinnedKeys.size,
        selectedProviderId: providerId,
        activeNav,
        activeProviderByVendor,
      }),
    [groups, visibleVirtualModels, pinnedKeys, providerId, activeNav, activeProviderByVendor]
  );

  // 弹层打开时才刷新订阅账号展示名（登录/登出可能已发生），关闭时不必轮询。
  // 同时预热所有订阅账号的额度：额度探测要打厂商端点（可能秒级延迟），
  // 若等到子菜单展开才拉，hover 停留期间往往还没返回；预热后命中 60s 共享缓存。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.electronAPI.providers.listOauth().then((infos) => {
      if (!cancelled) setOauthInfos(infos);
    });
    for (const provider of providers) {
      const accountKey = usageAccountKeyForProvider(provider, activeAccount);
      if (accountKey) prefetchAccountUsage(accountKey);
    }
    return () => {
      cancelled = true;
    };
  }, [open, providers, activeAccount]);

  // 打开时只清搜索词。搜索框 tabIndex=-1，避免根菜单 initialFocus 落到第一个可聚焦的
  // input 上；级联态焦点必须留在 Menu item，Esc 才能逐级退。点进搜索框 / 有关键词才是
  // 搜索模式，那时没有级联，Esc 一次关整棵。快捷键打开则主动聚焦搜索框。
  useEffect(() => {
    if (!open) return;
    setKeyword('');
    setActiveNav(null);
    openSubmenuIdsRef.current.clear();
    const focusSearch = pendingSearchFocusRef.current;
    pendingSearchFocusRef.current = false;
    searchFocusedRef.current = focusSearch;
    if (!focusSearch) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchFocusedRef.current = true;
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [open]);

  useEffect(() => {
    if (!listenHotkey) return;
    const onHotkey = () => {
      if (openRef.current) {
        searchInputRef.current?.focus();
        searchFocusedRef.current = true;
        return;
      }
      pendingSearchFocusRef.current = true;
      setOpen(true);
    };
    window.addEventListener(OPEN_CHAT_MODEL_PICKER_EVENT, onHotkey);
    return () => window.removeEventListener(OPEN_CHAT_MODEL_PICKER_EVENT, onHotkey);
  }, [listenHotkey]);

  const oauthAccountsByKey = useMemo(() => {
    const table: Record<string, { email?: string; plan?: string }> = {};
    for (const info of oauthInfos) {
      for (const account of info.accounts) table[account.key] = account;
    }
    return table;
  }, [oauthInfos]);

  // 每个 provider 条目对应的厂商名 + 条目展示名，供二级子菜单标题与搜索命中行的消歧标签共用
  const entryInfoByProviderId = useMemo(() => {
    const table: Record<
      string,
      {
        vendorLabel: string;
        primary: string;
        secondary?: string;
        plan?: string;
        isSubscription: boolean;
      }
    > = {};
    for (const group of groups) {
      const isCustomGroup =
        group.vendorId === CUSTOM_VENDOR_ID || group.vendorId.startsWith(`${CUSTOM_VENDOR_ID}:`);
      const vendorLabel = isCustomGroup ? t('Custom') : group.label;
      for (const provider of group.providers) {
        const { primary, secondary, plan, isSubscription } = entryLabelOf(
          provider,
          oauthAccountsByKey,
          t
        );
        table[provider.id] = { vendorLabel, primary, secondary, plan, isSubscription };
      }
    }
    return table;
  }, [groups, oauthAccountsByKey, t]);

  const pinnedHits = useMemo(() => {
    const hits: Array<{
      provider: ModelProvider;
      model: ModelEntry;
      entryTag: string;
      showId: boolean;
    }> = [];
    for (const provider of providers) {
      const info = entryInfoByProviderId[provider.id];
      const entryTag = info ? `${info.vendorLabel} · ${info.primary}` : provider.name;
      const duplicatedLabels = duplicateModelLabels(provider.models);
      for (const model of provider.models) {
        if (model.enabled === false) continue;
        if (!pinnedKeys.has(pinnedModelKey(provider.id, model.id))) continue;
        hits.push({
          provider,
          model,
          entryTag,
          showId: duplicatedLabels.has(model.label ?? model.id),
        });
      }
    }
    return hits;
  }, [providers, entryInfoByProviderId, pinnedKeys]);

  const handleMetaData = useCallback((pid: string, meta: Record<string, ModelMeta>) => {
    setMetaByProvider((prev) => (prev[pid] === meta ? prev : { ...prev, [pid]: meta }));
  }, []);

  const searching = keyword.trim().length > 0;
  const searchingRef = useRef(searching);
  searchingRef.current = searching;

  const searchHits = useMemo<SearchHit[]>(() => {
    if (!searching) return [];
    const q = keyword.trim();
    const hits: SearchHit[] = [];
    for (const provider of providers) {
      const info = entryInfoByProviderId[provider.id];
      const entryTag = info ? `${info.vendorLabel} · ${info.primary}` : provider.name;
      const duplicatedLabels = duplicateModelLabels(provider.models);
      for (const model of provider.models) {
        if (model.enabled === false) continue;
        const score = bestFieldScore(q, [
          [model.id, 1],
          [model.label ?? '', 1],
          [info?.primary ?? provider.name, 0.5],
          [info?.vendorLabel ?? '', 0.4],
        ]);
        if (score === null) continue;
        hits.push({
          provider,
          model,
          entryTag,
          score,
          showId: duplicatedLabels.has(model.label ?? model.id),
        });
      }
    }
    return hits.sort((a, b) => b.score - a.score);
  }, [searching, keyword, providers, entryInfoByProviderId]);
  const virtualHits = useMemo(
    () =>
      searching
        ? visibleVirtualModels.filter(
            (entry) => fuzzyMatchScore(keyword.trim(), entry.name) !== null
          )
        : visibleVirtualModels,
    [searching, keyword, visibleVirtualModels]
  );
  const virtualItems = virtualHits.map((entry) => (
    <MenuItem
      key={`virtual/${entry.id}`}
      className="min-h-6 gap-1.5 px-1.5 py-0.5 text-xs sm:min-h-6 sm:text-xs"
      data-model-picker-virtual={entry.id}
      onClick={() => handleSelectModel(VIRTUAL_PROVIDER_ID, entry.id)}
    >
      <Shuffle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate" title={entry.name}>
        {entry.name}
      </span>
      {currentVirtual?.id === entry.id && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
    </MenuItem>
  ));

  const handleSelectModel = useCallback(
    (targetProviderId: string, targetModelId: string) => {
      onSelect(targetProviderId, targetModelId);
      // 同一次交互内钳位:目标模型已知的支持档集若不含当前档,自动降到最近支持档并回写
      const target = findVirtualModel(virtualModels, {
        providerId: targetProviderId,
        modelId: targetModelId,
      })?.primary ?? { providerId: targetProviderId, modelId: targetModelId };
      const meta = metaByProvider[target.providerId]?.[target.modelId];
      const provider = providers.find((entry) => entry.id === target.providerId);
      const row = provider?.models.find((entry) => entry.id === target.modelId);
      const capability = resolvePickerCapabilities(
        provider,
        row,
        meta,
        // 切模型只替换 provider/model id，条目覆盖仍保留；归一化必须按切换后的同一份覆盖计算。
        modelCapabilityOverrides
      );
      const persisted = persistClampedThinkingLevel(
        thinkingLevel,
        capability.declaredThinkingLevels
      );
      if (persisted && !thinkingInherited) normalizeThinking(persisted);
      setOpen(false);
    },
    [
      onSelect,
      providers,
      virtualModels,
      modelCapabilityOverrides,
      metaByProvider,
      thinkingLevel,
      thinkingInherited,
      normalizeThinking,
    ]
  );

  const currentProviderMeta = useModelMeta(currentProvider);
  const currentModelMeta = currentProviderMeta[capabilityRef.modelId];
  const capability = useMemo(
    () =>
      resolvePickerCapabilities(
        currentProvider,
        current,
        currentModelMeta,
        modelCapabilityOverrides
      ),
    [currentProvider, current, currentModelMeta, modelCapabilityOverrides]
  );
  const supportedLevels = capability.thinkingLevels;
  const visibleLevels = useMemo(() => visibleThinkingLevels(supportedLevels), [supportedLevels]);
  const reasoningUnsupported = capability.reasoning === false || supportedLevels?.length === 0;
  const displayedReasoningEnabled =
    !reasoningUnsupported && (reasoningMode ? reasoningMode === 'on' : reasoningEnabled);
  const displayedThinkingLevel =
    visibleLevels.length > 0
      ? clampProjectThinkingLevel(thinkingLevel, visibleLevels)
      : thinkingLevel;

  /**
   * 归一化 effect：钳位不能只挂在 handleSelectModel 的 onClick 上，两条路径会漏掉——
   * ① 元数据是异步查询，选完模型那一刻可能还没到，到达后没人回头核对当前档是否仍合法；
   * ② 恢复已持久化会话完全不经过 onSelect，会话记忆里的档位可能对新连上的模型早已不支持。
   * 两种情况都要在 currentModelMeta 到位/变化时补一次回写；归一化回调缺省仍走会话状态
   * （分别对应 setThinking/setReasoning），不能只改本地显示，否则重启又变回不支持的值——
   * 这也顺带修好了 `reasoning:false` 时 Switch `checked={true} disabled` 打不开也关不掉的问题
   * （enabled 会被同步拨回 false）。
   * 只在「确实不支持」时才回写，`clampProjectThinkingLevel` 对已合法档位是恒等操作，
   * 配合这个判断，每次 meta 到位最多触发一次修正性 setState，不会死循环。
   */
  useEffect(() => {
    if (reasoningUnsupported) {
      if (reasoningEnabled && !reasoningInherited) normalizeReasoning(false);
      return;
    }
    if (!reasoningEnabled) return;
    const persisted = persistClampedThinkingLevel(thinkingLevel, capability.declaredThinkingLevels);
    if (persisted && !thinkingInherited) normalizeThinking(persisted);
  }, [
    capability.declaredThinkingLevels,
    reasoningUnsupported,
    reasoningEnabled,
    reasoningInherited,
    thinkingLevel,
    thinkingInherited,
    normalizeReasoning,
    normalizeThinking,
  ]);

  const handleRootOpenChange = useCallback(
    (
      nextOpen: boolean,
      details: { reason?: string; cancel: () => void; allowPropagation: () => void }
    ) => {
      if (
        interceptRootCascadeEscape(nextOpen, details, {
          openSubmenuCount: openSubmenuIdsRef.current.size,
          searchFocused: searchFocusedRef.current || searchingRef.current,
        })
      ) {
        return;
      }
      if (!nextOpen) {
        openSubmenuIdsRef.current.clear();
        searchFocusedRef.current = false;
      }
      setOpen(nextOpen);
    },
    []
  );

  const detailGroup = view.activeNav.kind === 'vendor' ? view.activeGroup : undefined;
  const detailProvider = view.activeNav.kind === 'vendor' ? view.activeProvider : undefined;
  const detailAccountKey = detailProvider
    ? usageAccountKeyForProvider(detailProvider, activeAccount)
    : undefined;
  const rememberAccount = (vendorId: string, accountId: string) => {
    setActiveProviderByVendor((prev) =>
      prev[vendorId] === accountId ? prev : { ...prev, [vendorId]: accountId }
    );
  };
  const thinkingLevelsControl =
    displayedReasoningEnabled && visibleLevels.length > 0 ? (
      <div
        role="group"
        aria-label={t('Thinking level')}
        data-thinking-levels="true"
        className={cn(
          'inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/60 p-0.5',
          reasoningMode && 'mt-2'
        )}
      >
        {visibleLevels.map((entry) => {
          const active = entry === displayedThinkingLevel;
          return (
            <button
              key={entry}
              type="button"
              tabIndex={-1}
              data-thinking-tick={entry}
              aria-pressed={active}
              disabled={visibleLevels.length === 1}
              onClick={() => onThinkingChange(entry)}
              className={cn(
                'rounded-[5px] px-2.5 py-0.5 text-[11px] leading-4 transition-all disabled:pointer-events-none',
                active
                  ? 'bg-background font-medium text-primary shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t(LEVEL_LABEL_KEYS[entry])}
            </button>
          );
        })}
      </div>
    ) : null;

  return (
    <div className={cn(triggerClassName && 'w-full min-w-0')}>
      <Menu open={open} onOpenChange={handleRootOpenChange}>
        <MenuTrigger
          data-model-picker="trigger"
          className={cn(
            'flex h-7 min-w-14 max-w-64 shrink items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            triggerClassName
          )}
          title={triggerLabel}
        >
          <span className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 truncate">{triggerLabel}</span>
            {hasSelection && showReasoningControls && reasoningMode ? (
              <span className="shrink-0 text-[10px]" data-reasoning-summary={reasoningMode}>
                {t(
                  reasoningMode === 'follow'
                    ? 'Follow parent'
                    : reasoningMode === 'on'
                      ? 'On'
                      : 'Off'
                )}
                {reasoningMode === 'on' && ` · ${t(LEVEL_LABEL_KEYS[displayedThinkingLevel])}`}
              </span>
            ) : hasSelection && showReasoningControls && displayedReasoningEnabled ? (
              <span
                className="flex shrink-0 items-center gap-0.5 text-primary"
                data-trigger-thinking={displayedThinkingLevel}
              >
                <Brain className="h-3 w-3" />
                {t(LEVEL_LABEL_KEYS[displayedThinkingLevel])}
              </span>
            ) : null}
          </span>
          <ChevronDown className={cn('h-3 w-3 shrink-0', formTrigger && 'ms-auto opacity-80')} />
        </MenuTrigger>
        <MenuPopup
          data-model-picker="root"
          side={side}
          align="start"
          className="w-[560px] max-w-[calc(100vw-2rem)]"
          zIndex={zIndex}
        >
          {providers.map((provider) => (
            <ModelMetaBridge key={provider.id} provider={provider} onData={handleMetaData} />
          ))}

          <div className="-mx-1.5 -mt-1.5 flex items-center gap-1 border-b px-2.5 py-1.5">
            <input
              ref={searchInputRef}
              data-model-picker="search"
              tabIndex={-1}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onFocus={() => {
                searchFocusedRef.current = true;
              }}
              onBlur={() => {
                searchFocusedRef.current = false;
              }}
              onKeyDown={stopTypeaheadOnly}
              placeholder={t('Search models')}
              className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
            />
            {refreshAllModels && (
              <button
                type="button"
                data-model-picker="refresh-all"
                disabled={refreshingAll}
                title={t('Refresh all models and info')}
                aria-label={t('Refresh all models and info')}
                onClick={() => void refreshAll()}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
              >
                {refreshingAll ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
              </button>
            )}
          </div>

          <div className="max-h-[268px] overflow-y-auto">
            {searching ? (
              <div className="py-1">
                {virtualItems}
                {searchHits.map(({ provider, model, entryTag, showId }) => {
                  const key = pinnedModelKey(provider.id, model.id);
                  return (
                    <MenuItem
                      key={`${provider.id}/${model.id}`}
                      className="min-h-6 gap-1.5 px-1.5 py-0.5 text-xs sm:min-h-6 sm:text-xs"
                      onClick={() => handleSelectModel(provider.id, model.id)}
                    >
                      <ModelRowContent
                        model={model}
                        meta={metaByProvider[provider.id]?.[model.id]}
                        entryTag={entryTag}
                        showId={showId}
                        selected={provider.id === providerId && model.id === modelId}
                        pin={{ key, pinned: pinnedKeys.has(key), onToggle: handleTogglePin }}
                      />
                    </MenuItem>
                  );
                })}
                {searchHits.length === 0 && virtualItems.length === 0 && (
                  <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                    {t('No models found')}
                  </p>
                )}
              </div>
            ) : groups.length === 0 && virtualItems.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                {t('No models found')}
              </p>
            ) : (
              <div data-model-picker="workbench" className="-mx-1.5 flex h-[268px] overflow-hidden">
                <div className="w-48 shrink-0 space-y-0.5 overflow-y-auto border-r bg-muted/15 p-1.5">
                  {view.showFavoritesNav && (
                    <button
                      type="button"
                      data-model-picker-nav="favorites"
                      onMouseEnter={() => setActiveNav({ kind: 'favorites' })}
                      onClick={() => setActiveNav({ kind: 'favorites' })}
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-accent',
                        view.activeNav.kind === 'favorites' && 'bg-accent'
                      )}
                    >
                      <Star className="h-3.5 w-3.5 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1 truncate">{t('Starred & virtual')}</span>
                      <Badge variant="outline" size="sm" className="shrink-0 text-[9px]">
                        {visibleVirtualModels.length + pinnedHits.length}
                      </Badge>
                    </button>
                  )}
                  {groups.map((group) => {
                    const vendorLabel =
                      group.vendorId === CUSTOM_VENDOR_ID ? t('Custom') : group.label;
                    const sole = group.providers.length === 1 ? group.providers[0] : undefined;
                    const soleInfo = sole ? entryInfoByProviderId[sole.id] : undefined;
                    const solePrimary = sole ? (soleInfo?.primary ?? sole.name) : undefined;
                    const soleSubtitle = sole
                      ? solePrimary === vendorLabel
                        ? (soleInfo?.secondary ?? t('Custom'))
                        : solePrimary
                      : undefined;
                    const selectedHere = group.providers.some(
                      (provider) => provider.id === providerId
                    );
                    const navActive =
                      view.activeNav.kind === 'vendor' &&
                      view.activeNav.vendorId === group.vendorId;
                    return (
                      <button
                        key={group.vendorId}
                        type="button"
                        data-model-picker-nav={`vendor:${group.vendorId}`}
                        data-model-picker-vendor={group.vendorId}
                        onMouseEnter={() =>
                          setActiveNav({ kind: 'vendor', vendorId: group.vendorId })
                        }
                        onClick={() => setActiveNav({ kind: 'vendor', vendorId: group.vendorId })}
                        className={cn(
                          'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-accent',
                          navActive && 'bg-accent'
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{vendorLabel}</span>
                          <span className="block truncate text-[10px] text-muted-foreground/70">
                            {sole
                              ? soleSubtitle
                              : t('{{count}} accounts', { count: group.providers.length })}
                          </span>
                        </span>
                        {sole && soleInfo?.plan && (
                          <Badge
                            variant="outline"
                            size="sm"
                            className="max-w-16 shrink-0 truncate text-[9px] uppercase"
                          >
                            {soleInfo.plan}
                          </Badge>
                        )}
                        {!sole && (
                          <Badge variant="outline" size="sm" className="shrink-0 text-[9px]">
                            {group.providers.length}
                          </Badge>
                        )}
                        {selectedHere && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                      </button>
                    );
                  })}
                </div>
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden p-1.5">
                  {view.activeNav.kind === 'favorites' ? (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      {virtualItems}
                      {pinnedHits.map(({ provider, model, entryTag, showId }) => {
                        const key = pinnedModelKey(provider.id, model.id);
                        return (
                          <MenuItem
                            key={`pin/${key}`}
                            className="min-h-6 gap-1.5 px-1.5 py-0.5 text-xs sm:min-h-6 sm:text-xs"
                            onClick={() => handleSelectModel(provider.id, model.id)}
                          >
                            <ModelRowContent
                              model={model}
                              meta={metaByProvider[provider.id]?.[model.id]}
                              entryTag={entryTag}
                              showId={showId}
                              selected={provider.id === providerId && model.id === modelId}
                              pin={{ key, pinned: true, onToggle: handleTogglePin }}
                            />
                          </MenuItem>
                        );
                      })}
                    </div>
                  ) : detailGroup && detailProvider ? (
                    <>
                      {detailGroup.providers.length > 1 ? (
                        <div
                          data-model-picker="account-tabs"
                          className="mb-1 flex flex-wrap gap-1 border-b pb-1.5"
                        >
                          {detailGroup.providers.map((provider) => {
                            const info = entryInfoByProviderId[provider.id];
                            const current = provider.id === detailProvider.id;
                            return (
                              <button
                                key={provider.id}
                                type="button"
                                data-model-picker-account={provider.id}
                                aria-pressed={current}
                                onMouseEnter={() =>
                                  rememberAccount(detailGroup.vendorId, provider.id)
                                }
                                onClick={() => rememberAccount(detailGroup.vendorId, provider.id)}
                                className={cn(
                                  'flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                                  current ? 'border-primary bg-accent' : 'hover:bg-accent'
                                )}
                              >
                                <span className="truncate">{info?.primary ?? provider.name}</span>
                                {info?.plan && (
                                  <Badge
                                    variant="outline"
                                    size="sm"
                                    className="max-w-16 shrink-0 truncate text-[9px] uppercase"
                                  >
                                    {info.plan}
                                  </Badge>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div
                          data-model-picker="account-header"
                          className={cn(
                            'mb-1 flex items-center justify-between gap-2 border-b px-1 pb-1 text-[11px]',
                            (!entryInfoByProviderId[detailProvider.id]?.secondary ||
                              (entryInfoByProviderId[detailProvider.id]?.primary ??
                                detailProvider.name) === detailGroup.label) &&
                              'sr-only'
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-1.5 truncate">
                            <span className="truncate">
                              {entryInfoByProviderId[detailProvider.id]?.primary ??
                                detailProvider.name}
                            </span>
                            {entryInfoByProviderId[detailProvider.id]?.secondary && (
                              <span className="truncate text-[10px] text-muted-foreground/70">
                                {entryInfoByProviderId[detailProvider.id]?.secondary}
                              </span>
                            )}
                          </span>
                          {entryInfoByProviderId[detailProvider.id]?.plan && (
                            <Badge
                              variant="outline"
                              size="sm"
                              className="max-w-20 shrink-0 truncate text-[9px] uppercase"
                            >
                              {entryInfoByProviderId[detailProvider.id]?.plan}
                            </Badge>
                          )}
                        </div>
                      )}
                      {detailAccountKey && <SubmenuUsage accountKey={detailAccountKey} />}
                      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                        <ProviderSubmenuList
                          key={detailProvider.id}
                          provider={detailProvider}
                          meta={metaByProvider[detailProvider.id]}
                          selectedProviderId={providerId}
                          selectedModelId={modelId}
                          pinnedKeys={pinnedKeys}
                          onTogglePin={handleTogglePin}
                          onSelectModel={(mid) => handleSelectModel(detailProvider.id, mid)}
                        />
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            )}
          </div>

          {showReasoningControls && (
            <div className="-mx-1.5 -mb-1.5 border-t bg-muted/15 px-3 py-1.5">
              <div
                className={cn(!reasoningMode && 'flex min-h-6 items-center justify-between gap-3')}
              >
                <div className="flex shrink-0 items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-foreground/85">
                    <Brain
                      className={cn(
                        'h-3.5 w-3.5',
                        displayedReasoningEnabled ? 'text-primary' : 'text-muted-foreground'
                      )}
                    />
                    {t('Reasoning')}
                  </span>
                  {!reasoningMode && (
                    <Switch
                      tabIndex={-1}
                      aria-label={t('Reasoning')}
                      checked={displayedReasoningEnabled}
                      onCheckedChange={onReasoningChange}
                      disabled={reasoningUnsupported}
                    />
                  )}
                </div>
                {!reasoningMode && thinkingLevelsControl}
              </div>
              {reasoningMode && (
                <div className="mt-2 flex gap-1" role="group" aria-label={t('Reasoning')}>
                  {(['follow', 'on', 'off'] as const).map((mode) => (
                    <Button
                      key={mode}
                      type="button"
                      size="sm"
                      variant={reasoningMode === mode ? 'default' : 'outline'}
                      className="h-7 flex-1 px-2 text-xs"
                      aria-pressed={reasoningMode === mode}
                      data-reasoning-mode={mode}
                      disabled={
                        mode === 'on' && !!currentProvider?.oauthAccountKey && reasoningUnsupported
                      }
                      onClick={() => onReasoningModeChange?.(mode, displayedThinkingLevel)}
                    >
                      {t(mode === 'follow' ? 'Follow parent' : mode === 'on' ? 'On' : 'Off')}
                    </Button>
                  ))}
                </div>
              )}
              {reasoningUnsupported && (!reasoningMode || !!currentProvider?.oauthAccountKey) && (
                <p className="mt-1 text-[10px] text-muted-foreground/70">
                  {t('{{model}} does not support reasoning', { model: current?.label ?? modelId })}
                </p>
              )}

              {reasoningMode === 'on' && displayedReasoningEnabled && (
                <p className="mt-2 text-xs">
                  {t('Depth: {{level}}', { level: t(LEVEL_LABEL_KEYS[displayedThinkingLevel]) })}
                </p>
              )}
              {reasoningMode && thinkingLevelsControl}
            </div>
          )}
        </MenuPopup>
      </Menu>
    </div>
  );
}
