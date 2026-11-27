import { pickModelCapabilityOverrides, resolveCustomModelView } from '@shared/modelCatalog';
import { clampProjectThinkingLevel, visibleThinkingLevels } from '@shared/modelThinking';
import { CUSTOM_VENDOR_ID, groupProviders, type ProviderGroup } from '@shared/providerGroups';
import type {
  ModelCapabilityOverrides,
  ModelEntry,
  ModelMeta,
  ModelProvider,
  ModelRef,
  OauthProviderInfo,
} from '@shared/types';
import type { ThinkingLevel } from '@shared/types/agent';
import { THINKING_LEVELS } from '@shared/types/agentConstants';
import {
  findVirtualModel,
  selectableVirtualModels,
  VIRTUAL_PROVIDER_ID,
  type VirtualModelEntry,
} from '@shared/virtualModels';
import {
  Brain,
  Check,
  ChevronDown,
  History,
  Loader2,
  RefreshCw,
  Shuffle,
  Star,
  X,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { providerDisplayName } from '@/components/settings/chatgptPool';
import {
  applyFetchedModels,
  fetchAllProviderModels,
  refreshProviders,
  summarizeFetchOutcomes,
  useProviderFetchState,
} from '@/components/settings/providerFetch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { SelectChevron, selectTriggerClassName } from '@/components/ui/select-trigger';
import { Switch } from '@/components/ui/switch';
import { addToast } from '@/components/ui/toast';
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
/** 设置行里的模型选择：与 SettingsSelect（ui 下拉 sm）同一外观 */
export const MODEL_PICKER_FORM_TRIGGER_CLASS = selectTriggerClassName('sm');
/** 对话框表单里的模型选择：与对话框里的 ui 下拉（默认尺寸）同一外观 */
export const MODEL_PICKER_DIALOG_TRIGGER_CLASS = selectTriggerClassName();

export function requestOpenChatModelPicker() {
  window.dispatchEvent(new Event(OPEN_CHAT_MODEL_PICKER_EVENT));
}

export type ModelPickerNavTarget =
  | { readonly kind: 'favorites' }
  | { readonly kind: 'recent' }
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

/** 让 item 在 list 内尽量垂直居中的 scrollTop；item.offsetParent 须为 list。 */
export function centeredScrollTop(
  list: { clientHeight: number; scrollHeight: number },
  item: { offsetTop: number; offsetHeight: number }
): number {
  const max = Math.max(0, list.scrollHeight - list.clientHeight);
  const target = item.offsetTop - (list.clientHeight - item.offsetHeight) / 2;
  return Math.min(max, Math.max(0, Math.round(target)));
}

/** 打开选择器时把第 index 行（选中的模型）滚进可视区；本来就整行可见时不动 */
export function scrollModelIntoList(list: HTMLElement | null, index: number): boolean {
  const item = index >= 0 ? (list?.children[index] as HTMLElement | undefined) : undefined;
  if (!list || !item) return false;
  const visible =
    item.offsetTop >= list.scrollTop &&
    item.offsetTop + item.offsetHeight <= list.scrollTop + list.clientHeight;
  if (visible) return false;
  list.scrollTop = centeredScrollTop(list, item);
  return true;
}

export function resolveActiveWorkbenchView(options: {
  groups: readonly ProviderGroup[];
  selectableVirtualModels: readonly VirtualModelEntry[];
  pinnedCount: number;
  /** 可用的最近使用条目数；为 0 时不显示该分组 */
  recentCount?: number;
  selectedProviderId: string;
  activeNav: ModelPickerNavTarget | null;
  activeProviderByVendor?: Readonly<Record<string, string>>;
}): {
  activeNav: ModelPickerNavTarget;
  activeGroup: ProviderGroup | undefined;
  activeProvider: ModelProvider | undefined;
  showFavoritesNav: boolean;
  showRecentNav: boolean;
} {
  const showFavoritesNav = options.selectableVirtualModels.length > 0 || options.pinnedCount > 0;
  const showRecentNav = (options.recentCount ?? 0) > 0;
  const favorites = {
    activeNav: { kind: 'favorites' } as const,
    activeGroup: undefined,
    activeProvider: undefined,
    showFavoritesNav,
    showRecentNav,
  };
  const explicit = options.activeNav;
  if (explicit?.kind === 'favorites' && showFavoritesNav) return favorites;
  if (explicit?.kind === 'recent' && showRecentNav) {
    return { ...favorites, activeNav: { kind: 'recent' } };
  }
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
        showRecentNav,
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
    showRecentNav,
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
  /** 仅会话选择器：选中即记入「最近使用」；设置页里的选择不算在用 */
  recordRecent?: boolean;
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
  /** 手机窄屏工具行：触发器限宽截断，虚拟模型只显示虚拟名（成员名移到弹层当前项） */
  compact?: boolean;
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
  // 收缩优先级：来源小字（basis 0）先让出空间、从账号一端截断；模型名按自身宽度排，
  // 小字收到 0 仍放不下才截断；上下文长度与 ✓ 不收缩。无小字时模型名占满剩余宽度。
  const nameFlex = entryTag ? 'flex-initial' : 'flex-1';
  return (
    <>
      {pin && <ModelPinButton pin={pin} />}
      {showId ? (
        <span className={cn('flex min-w-0 items-baseline gap-1.5 overflow-hidden', nameFlex)}>
          <span data-model-row-name className="min-w-0 truncate" title={name}>
            {name}
          </span>
          <span
            data-model-row-id={model.id}
            title={model.id}
            className="min-w-0 shrink-[999] truncate font-mono text-[10px] text-muted-foreground/70"
          >
            {model.id}
          </span>
        </span>
      ) : (
        <span data-model-row-name className={cn('min-w-0 truncate', nameFlex)} title={name}>
          {name}
        </span>
      )}
      {entryTag && (
        <span
          data-model-row-source
          className="min-w-0 flex-1 truncate text-right text-[10px] text-muted-foreground/60"
          title={entryTag}
        >
          {entryTag}
        </span>
      )}
      {windowTokens !== undefined && (
        <span
          data-model-row-context
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

/** 「最近使用」行尾的移除控件：悬停/高亮行时才显示；不是 button，避免嵌套交互元素，并拦住冒泡到行的选择。 */
function RecentRemoveButton({ refKey, onRemove }: { refKey: string; onRemove: () => void }) {
  const { t } = useI18n();
  const label = t('Remove from recently used');
  return (
    <span
      role="button"
      tabIndex={-1}
      data-model-recent-remove={refKey}
      aria-label={label}
      title={label}
      onMouseUp={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onRemove();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onRemove();
      }}
      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 group-data-highlighted:opacity-100"
    >
      <X className="h-3 w-3" />
    </span>
  );
}

/**
 * 左栏厂商行尾的刷新。和行按钮并列，避免 button 嵌套；拦住冒泡，以免切导航或关掉弹层。
 */
function VendorNavRefresh({
  vendorId,
  providers,
  emphasized,
  updateProvider,
}: {
  vendorId: string;
  providers: readonly ModelProvider[];
  emphasized: boolean;
  updateProvider: (id: string, patch: { models: ModelEntry[] }) => void;
}) {
  const { t } = useI18n();
  const { refreshing, error } = useProviderFetchState(providers.map((provider) => provider.id));
  const label = error ? `${t('Refresh failed')}: ${error}` : t('Refresh provider models');
  return (
    <button
      type="button"
      data-model-picker-nav-refresh={vendorId}
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void refreshProviders(providers, updateProvider);
      }}
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/40 hover:bg-accent hover:text-foreground focus-visible:text-foreground group-hover:text-foreground',
        emphasized && 'text-foreground',
        error && 'text-destructive'
      )}
    >
      {refreshing ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <RefreshCw className={cn('h-3.5 w-3.5', error && 'text-destructive')} />
      )}
    </button>
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

  // 弹层每次打开都会重新挂载这一栏：挂载时把选中的模型滚出来，之后的滚动与重渲染都不再拽回
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedIndexRef = useRef(-1);
  selectedIndexRef.current =
    provider.id === selectedProviderId
      ? visibleModels.findIndex((model) => model.id === selectedModelId)
      : -1;
  useLayoutEffect(() => {
    scrollModelIntoList(listRef.current, selectedIndexRef.current);
  }, []);

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
      <div
        ref={listRef}
        data-model-picker="model-list"
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
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

type RecentHit =
  | { kind: 'virtual'; ref: ModelRef; entry: VirtualModelEntry }
  | {
      kind: 'model';
      ref: ModelRef;
      provider: ModelProvider;
      model: ModelEntry;
      entryTag: string;
      showId: boolean;
    };

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
  recordRecent = false,
  onSelect,
  onReasoningChange,
  onThinkingChange,
  onReasoningNormalize,
  onThinkingNormalize,
  zIndex,
  emptyLabel,
  triggerLabel: triggerLabelProp,
  triggerClassName,
  compact = false,
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
  const recentModels = useSettingsStore((s) => s.recentModels);
  const recordRecentModel = useSettingsStore((s) => s.recordRecentModel);
  const removeRecentModel = useSettingsStore((s) => s.removeRecentModel);
  const allProviders = useSettingsStore((s) => s.providers);
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const [refreshingAll, setRefreshingAll] = useState(false);
  /** 先刷模型信息（统一目录），再按条目拉取全部模型清单：订阅条目的重拉依赖新目录。 */
  const refreshAll = useCallback(async () => {
    setRefreshingAll(true);
    try {
      const enabledProviders = allProviders.filter((provider) => provider.enabled);
      if (enabledProviders.length === 0) {
        addToast({ type: 'info', title: t('No enabled providers to sync') });
        return;
      }
      await window.electronAPI.providers.refreshModelCatalog();
      invalidateModelMeta();
      const outcomes = await fetchAllProviderModels(enabledProviders);
      applyFetchedModels(outcomes, updateProvider);
      const { okCount, failedCount, modelCount, firstError } = summarizeFetchOutcomes(outcomes);
      const skippedCount = allProviders.length - enabledProviders.length;
      const fetched =
        skippedCount > 0
          ? `${t('Fetched {{count}} models', { count: modelCount })} · ${t('Skipped {{count}} disabled providers', { count: skippedCount })}`
          : t('Fetched {{count}} models', { count: modelCount });
      addToast({
        type: failedCount > 0 ? 'warning' : 'success',
        title:
          failedCount === 0
            ? t('Fetched {{count}} providers', { count: okCount })
            : okCount > 0
              ? t('{{ok}} succeeded, {{failed}} failed', { ok: okCount, failed: failedCount })
              : t('Sync failed ({{failed}})', { failed: failedCount }),
        description:
          failedCount > 0
            ? `${fetched} · ${t('{{count}} failed', { count: failedCount })}: ${firstError}`
            : fetched,
      });
    } catch (error) {
      addToast({
        type: 'error',
        title: t('Fetch failed'),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRefreshingAll(false);
    }
  }, [allProviders, updateProvider, t]);
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
  // 弹层在 base-ui 门户里，打开那次提交时内容尚未挂载；渠道列表挂载时再滚，每次打开只滚一次
  const navListRef = useRef<HTMLDivElement | null>(null);
  const navScrollPendingRef = useRef(false);
  const scrollNavToSelectedOnce = useCallback(() => {
    const list = navListRef.current;
    if (!list || !navScrollPendingRef.current) return;
    navScrollPendingRef.current = false;
    const item = list.querySelector<HTMLElement>('[data-model-picker-nav-selected]');
    if (item) list.scrollTop = centeredScrollTop(list, item);
  }, []);
  const setNavList = useCallback(
    (node: HTMLDivElement | null) => {
      navListRef.current = node;
      scrollNavToSelectedOnce();
    },
    [scrollNavToSelectedOnce]
  );
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
  // 窄屏只露出用户选中的东西：虚拟名或裸模型名；路由成员和渠道前缀留在 title / 弹层
  const visibleTriggerLabel =
    compact && !triggerLabelProp && hasSelection
      ? (currentVirtual?.name ?? modelName)
      : triggerLabel;

  const groups = useMemo(
    () => expandWorkbenchGroups(groupProviders(providers, oauthInfos)),
    [providers, oauthInfos]
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

  useLayoutEffect(() => {
    navScrollPendingRef.current = open;
    if (open) scrollNavToSelectedOnce();
  }, [open, scrollNavToSelectedOnce]);

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

  // 已删除/停用的 provider 与模型、不可选的虚拟模型直接跳过，不显示点不了的条目
  const recentHits = useMemo(() => {
    const hits: RecentHit[] = [];
    for (const ref of recentModels ?? []) {
      if (ref.providerId === VIRTUAL_PROVIDER_ID) {
        const entry = visibleVirtualModels.find((item) => item.id === ref.modelId);
        if (entry) hits.push({ kind: 'virtual', ref, entry });
        continue;
      }
      const provider = providers.find((item) => item.id === ref.providerId);
      const model = provider?.models.find(
        (item) => item.id === ref.modelId && item.enabled !== false
      );
      if (!provider || !model) continue;
      const info = entryInfoByProviderId[provider.id];
      hits.push({
        kind: 'model',
        ref,
        provider,
        model,
        entryTag: info ? `${info.vendorLabel} · ${info.primary}` : provider.name,
        showId: duplicateModelLabels(provider.models).has(model.label ?? model.id),
      });
    }
    return hits;
  }, [recentModels, visibleVirtualModels, providers, entryInfoByProviderId]);

  const view = useMemo(
    () =>
      resolveActiveWorkbenchView({
        groups,
        selectableVirtualModels: visibleVirtualModels,
        pinnedCount: pinnedKeys.size,
        recentCount: recentHits.length,
        selectedProviderId: providerId,
        activeNav,
        activeProviderByVendor,
      }),
    [
      groups,
      visibleVirtualModels,
      pinnedKeys,
      recentHits.length,
      providerId,
      activeNav,
      activeProviderByVendor,
    ]
  );

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
  const renderVirtualItem = (entry: VirtualModelEntry, key: string, trailing?: ReactNode) => {
    // 窄屏触发器只显示虚拟名，当前路由成员挪到这一行
    const routed = compact && currentVirtual?.id === entry.id ? routedModelLabel : undefined;
    return (
      <MenuItem
        key={key}
        className={cn(
          'min-h-6 gap-1.5 px-1.5 py-0.5 text-xs sm:min-h-6 sm:text-xs',
          trailing && 'group'
        )}
        data-model-picker-virtual={entry.id}
        onClick={() => handleSelectModel(VIRTUAL_PROVIDER_ID, entry.id)}
      >
        <Shuffle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn('min-w-0 truncate', routed ? 'max-w-[50%] shrink-0' : 'flex-1')}
          title={entry.name}
        >
          {entry.name}
        </span>
        {routed && (
          <span
            className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
            data-model-picker-routed
            title={routed}
          >
            {routed}
          </span>
        )}
        {currentVirtual?.id === entry.id && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
        {trailing}
      </MenuItem>
    );
  };
  const virtualItems = virtualHits.map((entry) => renderVirtualItem(entry, `virtual/${entry.id}`));

  const handleSelectModel = useCallback(
    (targetProviderId: string, targetModelId: string) => {
      onSelect(targetProviderId, targetModelId);
      if (recordRecent) recordRecentModel({ providerId: targetProviderId, modelId: targetModelId });
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
      recordRecent,
      recordRecentModel,
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
    <div
      className={cn(
        triggerClassName && 'w-full min-w-0',
        // compact：只有模型芯片随宽度收缩（收缩的是这层 flex 项），下限留够档位与箭头，避免溢出压到邻居
        compact &&
          cn(
            'max-w-[10rem]',
            hasSelection && showReasoningControls && (reasoningMode || displayedReasoningEnabled)
              ? 'min-w-[4.5rem]'
              : 'min-w-[2.75rem]'
          )
      )}
    >
      <Menu open={open} onOpenChange={handleRootOpenChange}>
        <MenuTrigger
          data-model-picker="trigger"
          className={
            formTrigger
              ? triggerClassName
              : cn(
                  'flex shrink items-center rounded-lg text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                  compact ? 'h-[32px] w-full gap-0.5 px-1.5' : 'h-7 min-w-14 max-w-64 gap-1 px-2'
                )
          }
          title={triggerLabel}
        >
          <span className={cn('flex min-w-0 items-center gap-1', formTrigger && 'flex-1')}>
            <span className="min-w-0 truncate" data-model-picker-label>
              {visibleTriggerLabel}
            </span>
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
                <Brain className="size-3" />
                {t(LEVEL_LABEL_KEYS[displayedThinkingLevel])}
              </span>
            ) : null}
          </span>
          {formTrigger ? <SelectChevron /> : <ChevronDown className="h-3 w-3 shrink-0" />}
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

          {searching ? (
            <div className="max-h-[268px] overflow-y-auto py-1">
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
            <div
              data-model-picker="workbench"
              className={cn(
                '-mx-1.5 flex h-[268px] overflow-hidden',
                !showReasoningControls && '-mb-1.5'
              )}
            >
              <div
                ref={setNavList}
                data-model-picker="nav-list"
                className="relative w-36 shrink-0 space-y-0.5 overflow-y-auto border-r bg-muted/15 p-1.5 sm:w-48"
              >
                {view.showFavoritesNav && (
                  <button
                    type="button"
                    data-model-picker-nav="favorites"
                    data-model-picker-nav-selected={
                      providerId === VIRTUAL_PROVIDER_ID ? '' : undefined
                    }
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
                {view.showRecentNav && (
                  <button
                    type="button"
                    data-model-picker-nav="recent"
                    onMouseEnter={() => setActiveNav({ kind: 'recent' })}
                    onClick={() => setActiveNav({ kind: 'recent' })}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-accent',
                      view.activeNav.kind === 'recent' && 'bg-accent'
                    )}
                  >
                    <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{t('Recently used')}</span>
                    <Badge variant="outline" size="sm" className="shrink-0 text-[9px]">
                      {recentHits.length}
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
                    view.activeNav.kind === 'vendor' && view.activeNav.vendorId === group.vendorId;
                  return (
                    <div
                      key={group.vendorId}
                      data-model-picker-nav={`vendor:${group.vendorId}`}
                      data-model-picker-vendor={group.vendorId}
                      data-model-picker-nav-selected={selectedHere ? '' : undefined}
                      onMouseEnter={() =>
                        setActiveNav({ kind: 'vendor', vendorId: group.vendorId })
                      }
                      className={cn(
                        'group flex w-full items-center rounded-md text-left text-xs hover:bg-accent',
                        navActive && 'bg-accent'
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setActiveNav({ kind: 'vendor', vendorId: group.vendorId })}
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left"
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
                      <VendorNavRefresh
                        vendorId={group.vendorId}
                        providers={group.providers}
                        emphasized={navActive}
                        updateProvider={updateProvider}
                      />
                    </div>
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
                ) : view.activeNav.kind === 'recent' ? (
                  <div data-model-picker="recent-list" className="min-h-0 flex-1 overflow-y-auto">
                    {recentHits.map((hit) => {
                      const key = pinnedModelKey(hit.ref.providerId, hit.ref.modelId);
                      const remove = (
                        <RecentRemoveButton
                          refKey={key}
                          onRemove={() => removeRecentModel(hit.ref)}
                        />
                      );
                      if (hit.kind === 'virtual') {
                        return renderVirtualItem(hit.entry, `recent/${key}`, remove);
                      }
                      const { provider, model, entryTag, showId } = hit;
                      return (
                        <MenuItem
                          key={`recent/${key}`}
                          className="group min-h-6 gap-1.5 px-1.5 py-0.5 text-xs sm:min-h-6 sm:text-xs"
                          onClick={() => handleSelectModel(provider.id, model.id)}
                        >
                          <ModelRowContent
                            model={model}
                            meta={metaByProvider[provider.id]?.[model.id]}
                            entryTag={entryTag}
                            showId={showId}
                            selected={provider.id === providerId && model.id === modelId}
                            pin={{
                              key,
                              pinned: pinnedKeys.has(key),
                              onToggle: handleTogglePin,
                            }}
                          />
                          {remove}
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
