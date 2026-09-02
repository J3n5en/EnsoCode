import { resolveCustomModelView } from '@shared/modelCatalog';
import { clampProjectThinkingLevel } from '@shared/modelThinking';
import { CUSTOM_VENDOR_ID, groupProviders } from '@shared/providerGroups';
import type { ModelEntry, ModelMeta, ModelProvider, OauthProviderInfo } from '@shared/types';
import { THINKING_LEVELS, type ThinkingLevel } from '@shared/types/agent';
import { BadgeCheck, Brain, Check, ChevronDown, KeyRound } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from '@/components/ui/menu';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { prefetchAccountUsage, useCachedAccountUsage } from '@/hooks/useAccountUsage';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useModelMeta } from '@/stores/modelMeta';
import { formatTokens } from '@/stores/sessions/stats';
import { interceptRootCascadeEscape, markSubmenuOpen } from './modelPickerCascadeEsc';

export const OPEN_CHAT_MODEL_PICKER_EVENT = 'enso:open-chat-model-picker';

export function requestOpenChatModelPicker() {
  window.dispatchEvent(new Event(OPEN_CHAT_MODEL_PICKER_EVENT));
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
  providerId: string;
  modelId: string;
  reasoningEnabled: boolean;
  thinkingLevel: ThinkingLevel;
  /** 子代理模型清单等场景只复用 provider/account/model 级联，不展示 reasoning/thinking。 */
  showReasoningControls?: boolean;
  /** 仅会话工具行：响应全局「切换模型」快捷键并聚焦搜索框 */
  listenHotkey?: boolean;
  onSelect: (providerId: string, modelId: string) => void;
  onReasoningChange: (enabled: boolean) => void;
  onThinkingChange: (level: ThinkingLevel) => void;
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

/**
 * 一行模型的内容：名称 + （可选）所属条目标签 + 上下文窗口 + 选中标记。窗口缺失时整段不渲染
 * （不留占位符，有值才显示；`catalog-fallback` 来源仍标「估算」——那是有值，只是不够权威，
 * ⛔ 不编造数字）。
 *
 * ⚠️ 选中标记的槽位恒定占宽（`selected` 为 false 时槽位仍渲染，只是内部空着），不能写成
 * `selected && <Check/>` 那种整个节点条件渲染——`MenuItem` 是 flex 行，名称那一列用的是
 * `flex-1`（会自动吃掉行内剩余空间），选中标记要是时有时无，行内其余 shrink-0 兄弟元素的
 * 总宽度就会跟着变，挤压/放宽名称列，导致上下文窗口值的横坐标随选中状态左右跳动。槽位恒定后，
 * 同一份内容（同名称/同条目标签）无论选中与否，窗口值都落在同一个横坐标上。
 */
function ModelRowContent({
  model,
  meta,
  entryTag,
  selected,
}: {
  model: ModelEntry;
  meta: ModelMeta | undefined;
  entryTag?: string;
  selected: boolean;
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
  return (
    <>
      <span className="min-w-0 flex-1 truncate">{model.label ?? model.id}</span>
      {entryTag && (
        <span className="shrink-0 truncate text-[10px] text-muted-foreground/60">{entryTag}</span>
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
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {selected && <Check className="h-3.5 w-3.5 text-primary" />}
      </span>
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
  oauthAccountsByKey: Record<string, { email?: string; plan?: string }>
): { primary: string; secondary?: string; plan?: string; isSubscription: boolean } {
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
  onSelectModel,
}: {
  provider: ModelProvider;
  meta: Record<string, ModelMeta> | undefined;
  selectedProviderId: string;
  selectedModelId: string;
  onSelectModel: (modelId: string) => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const enabledModels = useMemo(
    () => provider.models.filter((m) => m.enabled !== false),
    [provider.models]
  );
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
        <div className="-mx-1 -mt-1 mb-1 border-b p-1.5">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={stopTypeaheadOnly}
            placeholder={t('Filter models in this entry')}
            className="h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </div>
      )}
      <div className="max-h-64 overflow-y-auto">
        {visibleModels.map((model) => (
          <MenuItem key={model.id} onClick={() => onSelectModel(model.id)}>
            <ModelRowContent
              model={model}
              meta={meta?.[model.id]}
              selected={provider.id === selectedProviderId && model.id === selectedModelId}
            />
          </MenuItem>
        ))}
        {visibleModels.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            {t('No models found')}
          </p>
        )}
      </div>
      {showFilter && (
        <p className="-mx-1 -mb-1 mt-1 border-t px-2 py-1 text-[10px] text-muted-foreground/60">
          {t('Showing {{shown}} of {{total}} models', {
            shown: visibleModels.length,
            total: enabledModels.length,
          })}
        </p>
      )}
    </>
  );
}

/** 订阅条目子菜单顶部的额度块：子菜单展开时才拉取（60s 共享缓存）；无数据/出错静默隐藏 */
function SubmenuUsage({ accountKey }: { accountKey: string }) {
  const { t } = useI18n();
  const info = useCachedAccountUsage(accountKey);
  if (!info || info.error || info.windows.length === 0) return null;
  return (
    <div className="-mx-1 -mt-1 mb-1 space-y-1 border-b px-3 py-2">
      {info.windows.map((windowInfo) => (
        <div key={windowInfo.label} className="flex items-center gap-2 text-[10px]">
          <span className="w-8 shrink-0 truncate text-muted-foreground">{windowInfo.label}</span>
          <div className="h-1 min-w-12 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${Math.max(0, Math.min(100, windowInfo.usedPercent))}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
            {Math.round(windowInfo.usedPercent)}%
          </span>
          {windowInfo.resetsAt !== undefined && (
            <span className="shrink-0 text-muted-foreground/60">
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
  score: number;
}

/**
 * composer 工具行的模型选择：级联菜单 —— 一级是供应商「条目」（按厂商用组标题归拢，
 * 同厂商多账号/自定义多网关各占独立一级项），hover/点击展开二级模型子菜单；
 * 关键词非空时改为跨条目的扁平模糊搜索列表。
 */
export function ModelPicker({
  providers,
  providerId,
  modelId,
  reasoningEnabled,
  thinkingLevel,
  showReasoningControls = true,
  listenHotkey = false,
  onSelect,
  onReasoningChange,
  onThinkingChange,
}: ModelPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const openSubmenuIdsRef = useRef(new Set<string>());
  const searchFocusedRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingSearchFocusRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const [hoverLockedIds, setHoverLockedIds] = useState<ReadonlySet<string>>(new Set());
  const [oauthInfos, setOauthInfos] = useState<OauthProviderInfo[]>([]);
  const [metaByProvider, setMetaByProvider] = useState<Record<string, Record<string, ModelMeta>>>(
    {}
  );

  const currentProvider = useMemo(
    () => providers.find((p) => p.id === providerId),
    [providers, providerId]
  );
  const current = currentProvider?.models.find((m) => m.id === modelId);

  const groups = useMemo(() => groupProviders(providers, oauthInfos), [providers, oauthInfos]);

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
      if (provider.oauthAccountKey) prefetchAccountUsage(provider.oauthAccountKey);
    }
    return () => {
      cancelled = true;
    };
  }, [open, providers]);

  // 打开时只清搜索词。搜索框 tabIndex=-1，避免根菜单 initialFocus 落到第一个可聚焦的
  // input 上；级联态焦点必须留在 Menu item，Esc 才能逐级退。点进搜索框 / 有关键词才是
  // 搜索模式，那时没有级联，Esc 一次关整棵。快捷键打开则主动聚焦搜索框。
  useEffect(() => {
    if (!open) return;
    setKeyword('');
    openSubmenuIdsRef.current.clear();
    setHoverLockedIds(new Set());
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
      const vendorLabel = group.vendorId === CUSTOM_VENDOR_ID ? t('Custom') : group.label;
      for (const provider of group.providers) {
        const { primary, secondary, plan, isSubscription } = entryLabelOf(
          provider,
          oauthAccountsByKey
        );
        table[provider.id] = { vendorLabel, primary, secondary, plan, isSubscription };
      }
    }
    return table;
  }, [groups, oauthAccountsByKey, t]);

  const handleMetaData = useCallback((pid: string, meta: Record<string, ModelMeta>) => {
    setMetaByProvider((prev) => (prev[pid] === meta ? prev : { ...prev, [pid]: meta }));
  }, []);

  const searching = keyword.trim().length > 0;
  const searchingRef = useRef(searching);
  searchingRef.current = searching;

  useEffect(() => {
    if (!searching) return;
    openSubmenuIdsRef.current.clear();
  }, [searching]);

  const searchHits = useMemo<SearchHit[]>(() => {
    if (!searching) return [];
    const q = keyword.trim();
    const hits: SearchHit[] = [];
    for (const provider of providers) {
      const info = entryInfoByProviderId[provider.id];
      const entryTag = info ? `${info.vendorLabel} · ${info.primary}` : provider.name;
      for (const model of provider.models) {
        if (model.enabled === false) continue;
        const score = bestFieldScore(q, [
          [model.id, 1],
          [model.label ?? '', 1],
          [info?.primary ?? provider.name, 0.5],
          [info?.vendorLabel ?? '', 0.4],
        ]);
        if (score === null) continue;
        hits.push({ provider, model, entryTag, score });
      }
    }
    return hits.sort((a, b) => b.score - a.score);
  }, [searching, keyword, providers, entryInfoByProviderId]);

  const handleSelectModel = useCallback(
    (targetProviderId: string, targetModelId: string) => {
      onSelect(targetProviderId, targetModelId);
      // 同一次交互内钳位:目标模型已知的支持档集若不含当前档,自动降到最近支持档并回写
      const meta = metaByProvider[targetProviderId]?.[targetModelId];
      const clamped = clampProjectThinkingLevel(thinkingLevel, meta?.thinkingLevels);
      if (clamped !== thinkingLevel) onThinkingChange(clamped);
      setOpen(false);
    },
    [onSelect, metaByProvider, thinkingLevel, onThinkingChange]
  );

  const currentProviderMeta = useModelMeta(currentProvider);
  const currentModelMeta = currentProviderMeta[modelId];
  const supportedLevels = currentModelMeta?.thinkingLevels;
  const reasoningUnsupported =
    currentModelMeta?.reasoning === false || supportedLevels?.length === 0;
  const levelIndex = Math.max(0, THINKING_LEVELS.indexOf(thinkingLevel));

  /**
   * 归一化 effect：钳位不能只挂在 handleSelectModel 的 onClick 上，两条路径会漏掉——
   * ① 元数据是异步查询，选完模型那一刻可能还没到，到达后没人回头核对当前档是否仍合法；
   * ② 恢复已持久化会话完全不经过 onSelect，会话记忆里的档位可能对新连上的模型早已不支持。
   * 两种情况都要在 currentModelMeta 到位/变化时补一次回写；回写走会话状态
   * （onThinkingChange/onReasoningChange 分别对应 setThinking/setReasoning），不能只改本地
   * 显示，否则重启又变回不支持的值——这也顺带修好了 `reasoning:false` 时 Switch
   * `checked={true} disabled` 打不开也关不掉的问题（enabled 会被同步拨回 false）。
   * 只在「确实不支持」时才回写，`clampProjectThinkingLevel` 对已合法档位是恒等操作，
   * 配合这个判断，每次 meta 到位最多触发一次修正性 setState，不会死循环。
   */
  useEffect(() => {
    if (!currentModelMeta) return; // 未知 = 不加限制，不回写
    if (reasoningUnsupported) {
      if (reasoningEnabled) onReasoningChange(false);
      return;
    }
    if (!reasoningEnabled || supportedLevels === undefined) return;
    if (supportedLevels.includes(thinkingLevel)) return;
    onThinkingChange(clampProjectThinkingLevel(thinkingLevel, supportedLevels));
  }, [
    currentModelMeta,
    reasoningUnsupported,
    supportedLevels,
    reasoningEnabled,
    thinkingLevel,
    onReasoningChange,
    onThinkingChange,
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
        setHoverLockedIds(new Set(openSubmenuIdsRef.current));
        return;
      }
      if (!nextOpen) {
        openSubmenuIdsRef.current.clear();
        searchFocusedRef.current = false;
        setHoverLockedIds(new Set());
      }
      setOpen(nextOpen);
    },
    []
  );

  return (
    <Menu open={open} onOpenChange={handleRootOpenChange}>
      <MenuTrigger
        data-model-picker="trigger"
        className="flex h-7 max-w-64 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <span className="truncate">{current?.label ?? modelId ?? t('Model')}</span>
        {reasoningEnabled && (
          <span className="flex shrink-0 items-center gap-0.5 text-primary">
            <Brain className="h-3 w-3" />
            {t(LEVEL_LABEL_KEYS[thinkingLevel])}
          </span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0" />
      </MenuTrigger>
      <MenuPopup data-model-picker="root" side="top" align="start" className="w-80">
        {providers.map((provider) => (
          <ModelMetaBridge key={provider.id} provider={provider} onData={handleMetaData} />
        ))}

        <div className="-mx-1 -mt-1 mb-1 border-b p-2">
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
            className="h-8 w-full rounded-md border bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </div>

        <div className="max-h-72 overflow-y-auto">
          {searching ? (
            <>
              {searchHits.map(({ provider, model, entryTag }) => (
                <MenuItem
                  key={`${provider.id}/${model.id}`}
                  onClick={() => handleSelectModel(provider.id, model.id)}
                >
                  <ModelRowContent
                    model={model}
                    meta={metaByProvider[provider.id]?.[model.id]}
                    entryTag={entryTag}
                    selected={provider.id === providerId && model.id === modelId}
                  />
                </MenuItem>
              ))}
              {searchHits.length === 0 && (
                <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                  {t('No models found')}
                </p>
              )}
            </>
          ) : (
            <>
              {groups.map((group) => (
                <MenuGroup key={group.vendorId}>
                  <MenuGroupLabel>
                    {group.vendorId === CUSTOM_VENDOR_ID ? t('Custom') : group.label}
                  </MenuGroupLabel>
                  {group.providers.map((provider) => {
                    const info = entryInfoByProviderId[provider.id];
                    const isSubscription =
                      info?.isSubscription ?? Boolean(provider.oauthAccountKey);
                    return (
                      <MenuSub
                        key={provider.id}
                        onOpenChange={(next) => {
                          markSubmenuOpen(openSubmenuIdsRef.current, provider.id, next);
                        }}
                      >
                        <MenuSubTrigger
                          openOnHover={!hoverLockedIds.has(provider.id)}
                          onPointerLeave={() => {
                            setHoverLockedIds((prev) => {
                              if (!prev.has(provider.id)) return prev;
                              const next = new Set(prev);
                              next.delete(provider.id);
                              return next;
                            });
                          }}
                        >
                          {isSubscription ? (
                            <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="flex min-w-0 flex-1 flex-col items-start overflow-hidden">
                            <span className="w-full truncate text-left">
                              {info?.primary ?? provider.name}
                            </span>
                            {info?.secondary && (
                              <span className="w-full truncate text-left text-[10px] text-muted-foreground/60">
                                {info.secondary}
                              </span>
                            )}
                          </span>
                          {info?.plan && (
                            <Badge
                              variant="outline"
                              size="sm"
                              className="max-w-20 shrink-0 truncate text-[9px] uppercase"
                            >
                              {info.plan}
                            </Badge>
                          )}
                          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                            {provider.id === providerId && (
                              <Check className="h-3.5 w-3.5 text-primary" />
                            )}
                          </span>
                        </MenuSubTrigger>
                        <MenuSubPopup data-model-picker="submenu" className="w-72">
                          {provider.oauthAccountKey && (
                            <SubmenuUsage accountKey={provider.oauthAccountKey} />
                          )}
                          <ProviderSubmenuList
                            provider={provider}
                            meta={metaByProvider[provider.id]}
                            selectedProviderId={providerId}
                            selectedModelId={modelId}
                            onSelectModel={(mid) => handleSelectModel(provider.id, mid)}
                          />
                        </MenuSubPopup>
                      </MenuSub>
                    );
                  })}
                </MenuGroup>
              ))}
              {groups.length === 0 && (
                <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                  {t('No models found')}
                </p>
              )}
            </>
          )}
        </div>

        {showReasoningControls && (
          <div className="-mx-1 -mb-1 mt-1 border-t p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-xs">
                <Brain className="h-3.5 w-3.5 text-muted-foreground" />
                {t('Reasoning')}
              </span>
              <Switch
                tabIndex={-1}
                checked={reasoningEnabled}
                onCheckedChange={onReasoningChange}
                disabled={reasoningUnsupported}
              />
            </div>
            {reasoningUnsupported && (
              <p className="mt-1 text-[10px] text-muted-foreground/70">
                {t('{{model}} does not support reasoning', { model: current?.label ?? modelId })}
              </p>
            )}

            {reasoningEnabled && !reasoningUnsupported && (
              <div className="mt-3">
                <Slider
                  tabIndex={-1}
                  min={0}
                  max={THINKING_LEVELS.length - 1}
                  step={1}
                  value={levelIndex}
                  onValueChange={(value) => {
                    const index = Array.isArray(value) ? value[0] : value;
                    const target = THINKING_LEVELS[index] ?? 'medium';
                    onThinkingChange(clampProjectThinkingLevel(target, supportedLevels));
                  }}
                />
                <div className="mt-1 flex justify-between gap-0">
                  {THINKING_LEVELS.map((entry, index) => {
                    const disabled =
                      supportedLevels !== undefined && !supportedLevels.includes(entry);
                    return (
                      <button
                        key={entry}
                        type="button"
                        tabIndex={-1}
                        disabled={disabled}
                        onClick={disabled ? undefined : () => onThinkingChange(entry)}
                        className={cn(
                          'flex min-w-0 flex-1 flex-col items-center gap-0',
                          index === 0 && 'items-start',
                          index === THINKING_LEVELS.length - 1 && 'items-end',
                          disabled && 'cursor-not-allowed'
                        )}
                      >
                        <span className="h-1.5 w-px bg-muted-foreground/40" />
                        <span
                          className={cn(
                            'text-[10px] transition-colors',
                            entry === thinkingLevel
                              ? 'font-medium text-primary'
                              : disabled
                                ? 'text-muted-foreground/30'
                                : 'text-muted-foreground/70 hover:text-foreground'
                          )}
                        >
                          {t(LEVEL_LABEL_KEYS[entry])}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </MenuPopup>
    </Menu>
  );
}
