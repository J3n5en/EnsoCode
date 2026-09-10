# 组件规范

## 三层组件

| 目录 | 用途 | 命名 | 改动策略 |
|------|------|------|----------|
| `components/ui/` | base-ui 的样式封装 | kebab-case | 尽量不改，改了影响全局 |
| `components/app/` | 应用级组件（标题栏等） | PascalCase | 按需 |
| `components/settings/` | 设置页各面板与弹窗 | PascalCase | 业务改动主要在这里 |

**不要直接 import `@base-ui/react`**，一律经 `components/ui/` 封装。
需要的组件那里没有时，先看是否能用现有的组合出来，确实需要再新增一个封装文件，
风格对齐同目录既有文件（`cn()` 合并 className、透传 props、`data-slot` 标记）。

## className 落在哪一层

这是本仓库最容易出错的地方。`Input` 渲染的是**两层结构**：

```tsx
<span className={cn('relative inline-flex w-full rounded-lg border ...', className)}>
  <InputPrimitive className="h-8.5 w-full px-[calc(--spacing(3)-1px)] ..." />
</span>
```

传给 `Input` 的 `className` 落在**外层 span**（带边框那层），内部 `<input>` 有自己的
`px-3`。所以：

- 想改**边框、背景、高度、字号** → 直接传，`className="h-8 text-xs"`。
- 想改**内部输入区的内边距**（比如给图标腾位置）→ 必须用子选择器：

```tsx
// 正确
<Input className="[&_input]:pl-8" />
// 错误：撑的是外层容器内边距，整个输入区被往右推 2rem，视觉上一大片留白
<Input className="pl-8" />
```

实例见 `ProviderEditDialog.tsx` 的筛选框（`[&_input]:pl-8`）和 API Key 输入框
（`[&_input]:pr-10`）。

## 输入框内的图标要 z-10

图标绝对定位在 `Input` **之前**时会被输入框自身的 `bg-background` 盖住 ——
同层叠上下文里后来的定位元素覆盖先来的。加 `z-10`：

```tsx
<div className="relative min-w-0 flex-1">
  <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
  <Input className="[&_input]:pl-8" />
</div>
```

写在 `Input` **之后**的元素（如 API Key 的眼睛按钮）不受影响。

## Field 不会自动撑满

`components/ui/field.tsx` 的 `Field` 是 `flex flex-col items-start`，
子元素会收缩到内容宽度。所以 `Field` 内的容器都要显式 `w-full`：

```tsx
<Field>
  <div className="flex w-full items-center justify-between">...</div>
  <div className="max-h-48 w-full overflow-y-auto rounded-md border p-1">...</div>
</Field>
```

`Input` / `SelectTrigger` 自带 `w-full`，其余自写的 div 都要加。

## 列表行的统一形状

设置页的列表项（provider / skill / MCP / instruction）用同一套结构，
新增列表照抄这个形状：

```tsx
<div className="group flex items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent/50">
  <div className="flex min-w-0 items-center gap-2">
    <span className={cn('shrink-0 font-medium text-sm', !enabled && 'text-muted-foreground line-through')}>{name}</span>
    <Badge variant="outline" className="shrink-0 text-[11px]">{kind}</Badge>
    <span className="min-w-0 truncate text-muted-foreground text-xs">{detail}</span>
  </div>
  <div className="flex shrink-0 items-center gap-1">
    <Switch checked={enabled} onCheckedChange={...} />
    {/* 操作按钮：平时隐藏，悬停显现 */}
    <Button variant="ghost" size="icon"
      className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
      <Pencil className="h-3.5 w-3.5" />
    </Button>
  </div>
</div>
```

要点：容器 `group` + 按钮 `opacity-0 group-hover:opacity-100`；
可伸缩文本 `min-w-0 truncate`，固定元素 `shrink-0`；禁用态用删除线加灰字。

## 长列表要能筛选和批量操作

超过几十项的列表（如某个 provider 有 134 个模型）必须提供：搜索框过滤、
对**筛选结果**生效的全开/全关、以及「已启用 N/M」计数。
参照 `ProviderEditDialog.tsx` 的模型列表 —— 批量按钮只作用于 `visibleModels`，
这样「搜 gpt-4 → 全部启用」才有意义。

## 空态

列表为空时用虚线框空态，不要只留一片空白：

```tsx
<div className="rounded-md border border-dashed px-3 py-8 text-center">
  <Icon className="mx-auto h-5 w-5 text-muted-foreground" />
  <p className="mt-3 font-medium text-sm">{t('No skills yet')}</p>
  <p className="mt-1 text-muted-foreground text-xs">{t('...引导下一步操作')}</p>
</div>
```

## 代码 diff 高亮走 worker 池

`@pierre/diffs` 的 `CodeView` / `FileDiff` / `File` 默认在主线程同步跑 shiki **JS 正则引擎**：
100 KB 源码 ≈ 2 s 卡死（CDP profile 全在 `findNextMatchSync`）。主窗口根部已挂
`components/chat/DiffWorkerPool.tsx`（`WorkerPoolContextProvider`，worker 经 Vite `?worker` 引入，
`electron.vite.config.ts` 里 `worker.format: 'es'`——iife 打不了 code-splitting）。

- 新的 diff 展示**不要传 `disableWorkerPool`**，直接吃池；主题/语言只改 `codeHighlighter.ts` 的
  `CODE_THEME` / `LANGS`，provider 引用同一份，不另开分叉。
- 聊天 `EditDiff` 也已接池（它展开时是全文 diff，量和 Changes 面板同级）。只剩编辑态 `File edit`（FilesView）
  仍是 `disableWorkerPool`：每次击键重高亮，走 worker 会变成颜色晚半拍跟上，去掉前在真机验一次编辑回显。
- **`fileDiff.cacheKey` 必须掺内容**：用 `lib/diffCacheKey.ts` 的 `diffCacheKey(name, old, new)` 覆盖。库默认只拿
  文件名当 key（`parseDiffFromFile` 和 `FileDiff.render` 都会自动填），worker 池按 key 缓存高亮，同名不同内容
  （Agent 连续改同一文件、聊天里多条同文件 edit）会拿旧结果套新 diff，直接抛
  `DiffHunksRenderer.processDiffResult: deletionLine and additionLine are null`。
- 只有 `index.html` 挂了 provider，设置窗没有；`index.html` CSP 的 `worker-src 'self' blob:` 是它的前提。
- 验证方法：CDP `/json/list` 应出现 `type: worker`；prod 是 `file://`，模块 worker 照常可加载
  （已用 bogus 消息回 `Unknown request type` 验过）。

## 时间线初始高度不能取首条消息

`MessageTimeline` 切会话会重挂 Virtuoso 并定位 `LAST`。必须提供 `defaultItemHeight` 初始估算，不能让首条长文本的探测高度外推到全部消息；实际行高仍动态测量，不能改成 `fixedItemHeight`。

首条高度异常时，总高会被放大几十倍，初始定位反复修正。此时 Virtuoso 隐藏正文、但不隐藏 Footer，表现为白屏只剩三个点，滚动条先很短、滚动测量后又变长，不代表历史尚未读回。

回归：在隔离 dev 环境、窗口保持可见时运行 `node scripts/verify-timeline-height.mjs`，真实测量长首条 / 长末条 / 往返切换 / 短列表的总高、正文可见和末条贴底；脚本不改会话或设置。

## 子模型思考与条目开关

条目 enabled（可供派发）和 reasoning（是否思考）是两个开关。禁用条目保留编辑内容，显示“已停用”。
思考 popup 使用三态：Follow 清除 reasoning/thinkingLevel；On 立即显示滑块，缺档位时同时写入支持的默认档；Off 隐藏滑块但保留上次程度。
不能再叠“自定义”“深度跟随”要求第二次点击，也不要拿全局默认值伪装父会话状态。

`ModelPicker` 主聊天保留二态开关；子模型传 `reasoningMode` 和 `onReasoningModeChange(mode, level)`。
自定义子模型编辑允许条目覆盖 provider 行，选择的努力档不能反过来缩小滑块而无法升档；OAuth 仍以 catalog 支持集为界。

Slider tick 与 thumb 必须共用 `index / max(1, levels.length - 1)` 坐标。不要用等宽 flex 格子中心画刻度。
本选择器局部用 `thumbAlignment="center"` 并去除 indicator 起点外边距；单档 min=0/max=1/value=0 且 disabled。
回归验收要真实测量 thumb center、fill right、tick x；SSR/mock Slider 只能验证 props，不能证明布局对齐。
