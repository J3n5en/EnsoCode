/**
 * 状态栏段位与预设模式。
 *
 * ⚠️ 段位分左右两组，顺序即「看它的时机」：
 *   左组 `model | approval | cwd | sessionName` —— 我在哪、用什么跑、什么权限
 *   右组 `coworkers | tokens | cache | context | turns | speed | duration | usage` —— 这轮跑得怎么样
 * 不做 git 分支与费用两段：前者要在 main 侧新增 git 能力，超出状态栏范围；
 * 后者本应用的 usage.cost 恒为 0（订阅计费 + 自定义 provider 注册时 cost 全零），
 * 显示 $0.00 属于误导。
 *
 * ⚠️ `STATUS_LINE_SEGMENT_IDS` 是**段位 id 的权威全集**，同时充当预设的书写顺序来源；
 * 它**不是**渲染顺序 —— 渲染顺序由用户可拖拽的 `statusLineSegments` 数组自身决定。
 */
export const STATUS_LINE_SEGMENT_IDS = [
  // 左组：在哪、用什么跑
  'model',
  'approval',
  'cwd',
  'sessionName',
  // 右组：这轮跑得怎么样
  'coworkers',
  'tokens',
  'cache',
  'context',
  'turns',
  'speed',
  'duration',
  'sessionTime',
  'usage',
] as const;

export type StatusLineSegmentId = (typeof STATUS_LINE_SEGMENT_IDS)[number];

export const STATUS_LINE_PRESET_IDS = ['minimal', 'default', 'full'] as const;
export type StatusLinePresetId = (typeof STATUS_LINE_PRESET_IDS)[number];

/**
 * 三种预设模式。数组顺序即该预设的渲染顺序，与段位声明序同一套分组逻辑。
 * - `minimal` 简洁：只留「在用什么模型」与「还剩多少上下文」这两条决策信息
 * - `default` 默认：原 StatsLine 的 5 组（tokens/cache/turns/speed/duration）超集
 *   + model + context + sessionTime，对老用户无信息回归
 * - `full` 完整：全部段位
 *
 * ⚠️ `duration` 与 `sessionTime` 是**两个不同的量**，都保留：
 *   `duration`   = agent 真正在跑的累计时长（LLM + 工具，空闲不计）→ 「烧了多少算力」
 *   `sessionTime` = 会话开始至今的墙钟时长（含空闲）→ 「这件事做了多久」
 *
 * ⚠️ `usage`（订阅额度窗口）**故意不进 `default`**：它要经 `providers.oauthAccountUsage()`
 * 打厂商额度端点，默认开启等于让每个用户的状态栏持续轮询外部 API。只进 `full` 与手动勾选。
 */
export const STATUS_LINE_PRESETS: Readonly<
  Record<StatusLinePresetId, readonly StatusLineSegmentId[]>
> = {
  minimal: ['model', 'context'],
  default: ['model', 'tokens', 'cache', 'context', 'turns', 'speed', 'duration', 'sessionTime'],
  full: STATUS_LINE_SEGMENT_IDS,
};

/** 新装/未配置时的段位序列，等价于 `default` 预设 */
export const DEFAULT_STATUS_LINE_SEGMENTS: readonly StatusLineSegmentId[] =
  STATUS_LINE_PRESETS.default;

/**
 * 当前段位序列等价于哪个预设；都不等价即 `'custom'`。
 *
 * ⚠️ 预设**不进持久化存储**：存的只有 `statusLineSegments` 这一个事实源，
 * 「现在是哪个模式」一律由它反推。于是「用户改了任何东西 → 立刻变自定义」
 * 是推导出来的结果，不需要额外维护一个可能与段位序列不一致的 preset 字段。
 *
 * ⚠️ 比较按**序列语义**（顺序敏感）：段位可拖拽排序，所以「同样这几段、换了顺序」
 * 也是用户的自定义结果，必须判成 `'custom'`。
 */
export function statusLinePresetOf(
  segments: readonly StatusLineSegmentId[]
): StatusLinePresetId | 'custom' {
  for (const presetId of STATUS_LINE_PRESET_IDS) {
    const preset = STATUS_LINE_PRESETS[presetId];
    if (preset.length === segments.length && preset.every((id, i) => segments[i] === id)) {
      return presetId;
    }
  }
  return 'custom';
}

/**
 * 把 `from` 位置的段位移动到 `to` 位置，返回新数组（拖拽排序用）。
 *
 * 越界或原地不动时返回**原数组引用**，让调用方可以据此跳过 set —— 拖拽过程中
 * 会高频触发，避免每次都产生新引用打断 React 的记忆化。
 */
export function reorderStatusLineSegments(
  segments: readonly StatusLineSegmentId[],
  from: number,
  to: number
): readonly StatusLineSegmentId[] {
  if (from === to) return segments;
  if (from < 0 || from >= segments.length) return segments;
  if (to < 0 || to >= segments.length) return segments;
  const next = [...segments];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * 归一化外部来源的段位序列（持久化数据、IPC 入参等）。
 *
 * 为什么必须有：`statusLineSegments` 存在磁盘上的 settings.json 里，用户手改、旧版本
 * 残留、外部工具都可能写进任意内容。而消费侧会对它做 `.includes` / `.filter` 并用 id
 * 去查段位图标——**非数组会直接抛**，**非法 id 会让「查不到的图标」被当组件渲染而白屏**，
 * 且坏值跨重启一直崩。所以在信任边界一次性收干净。
 *
 * 规则：非数组 → 回默认；过滤到权威 id 全集；按首次出现去重。
 * ⚠️ **必须保序**：数组顺序就是渲染顺序（用户可拖拽），归一化不得重排。
 * ⚠️ 合法输入原样返回（含空数组——那是「全部关闭」这个有效状态，不能当损坏数据回默认）。
 */
export function normalizeStatusLineSegments(value: unknown): StatusLineSegmentId[] {
  if (!Array.isArray(value)) return [...DEFAULT_STATUS_LINE_SEGMENTS];
  const valid = new Set<string>(STATUS_LINE_SEGMENT_IDS);
  const seen = new Set<string>();
  const next: StatusLineSegmentId[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !valid.has(entry) || seen.has(entry)) continue;
    seen.add(entry);
    next.push(entry as StatusLineSegmentId);
  }
  return next;
}
