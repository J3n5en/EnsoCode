# 样式规范

## Tailwind 4 + 语义令牌

`src/renderer/styles/globals.css` 用 `@theme` 把 CSS 变量映射成 Tailwind 工具类，
颜色值用 `oklch`。

**只用语义令牌，不写具体色值**：

```tsx
// 正确
className="bg-background text-muted-foreground border-border"
className="text-destructive"
// 错误：暗色模式和终端主题同步都会失效
className="bg-white text-gray-500 border-gray-200"
className="text-red-500"
```

可用语义色：`background` / `foreground` / `card` / `popover` / `primary` /
`secondary` / `muted` / `accent` / `destructive` / `success` / `warning` / `info` /
`border` / `input` / `ring`，各自都有 `-foreground` 配对。

例外：确实需要固定色相的状态提示（如测试成功的绿色）写
`text-emerald-600 dark:text-emerald-500`，两种模式都要给。

## cn() 合并类名

一律用 `src/renderer/lib/utils.ts` 的 `cn()`（clsx + tailwind-merge），
它能正确处理冲突类的覆盖：

```tsx
className={cn('text-sm font-medium', !enabled && 'text-muted-foreground line-through', className)}
```

不要手写模板字符串拼接 —— `` `text-sm ${cond ? 'text-lg' : ''}` `` 会两个类都留下。

## 字号是 14px，注意 rem

`:root` 的 `--font-size-base` 是 14px，**Tailwind 的 rem 类会按 14 换算**：
`h-11` = 2.75rem = 38.5px，不是 44px。

与主进程写死的像素值对齐时（如 `trafficLightPosition`），用固定像素类：

```tsx
<div className="h-[44px] pl-[84px]">   // 而不是 h-11 pl-20
```

## 主题系统

三种模式由 `theme` 字段驱动（`light` / `dark` / `system` / `sync-terminal`），
实现在 `stores/settings/index.ts` 的 `applyAppTheme` 与 `applySettings`：

- 前三种：切换 `<html>` 的 `dark` 类。
- `sync-terminal`：调 `applyTerminalThemeToApp()`，把 ghostty 终端主题的配色
  写进全局 CSS 变量，让整个界面跟随终端配色。

**配色方案选择器只在 `sync-terminal` 模式下影响界面外观**。
在 `system`/`light`/`dark` 下改配色方案看不到界面变化，这是设计如此，不是 bug。

终端主题数据在 `src/renderer/data/terminal-themes.json`（438 个），
由 `pnpm generate:themes` 生成，**不要手改**。

## 背景图透明化：新界面默认自动跟随，别绕过它

用户可开「背景图」（设置 → 外观）。实现不是透明窗口，而是
`hooks/useBackgroundImage.ts` 给 `<html>` 挂 `bg-image-enabled` 类并写入几个 alpha 变量，
`globals.css` 里用相对颜色把 **`--color-*` 令牌**（Tailwind 引用层）重映射成半透明：

| 变量 | 作用范围 | 来源 |
|------|---------|------|
| `--bg-panel-alpha` | 普通面板（`bg-background` / `bg-card` / `bg-muted` / `bg-sidebar`…） | 1 − 背景可见度 |
| `--bg-popover-alpha` | 弹出层（`bg-popover`），保底 0.92 | 派生 |
| `--bg-border-alpha` | 边框 | 面板 + 0.25 |
| `--bg-code-alpha` | 代码块 / diff / 终端 | 「代码块不透明度」滑块 |
| `--bg-composer-alpha` | 输入框 `[data-slot="composer"]` | 「输入框不透明度」滑块 |

**新页面只要用语义令牌类（`bg-background` 等）就自动跟随，什么都不用做。**
以下写法会绕过机制，让新面板在背景图模式下变成一块不透明的砖：

```tsx
// 错误：/60 把 alpha 硬编码进颜色，不再随可见度联动（SidePanel 曾踩过）
className="bg-background/60"
// 错误：内联色值、第三方主题色（xterm/shiki/@pierre/diffs 都自带不透明底色）
style={{ backgroundColor: theme.background }}
```

处理办法按情况选：

- **只是想要「稍暗一层」的层次感** → 用不同令牌（`bg-muted` / `bg-card`），不要用 `/N` 修饰符。
  确实需要 `/N` 的只限 hover/选中等瞬态（`hover:bg-accent/50`），不能用在承载内容的面板底色上。
- **第三方组件自己刷底色**（终端、代码高亮、diff）→ 给宿主元素挂 `data-slot`，在
  `globals.css` 的 `html.bg-image-enabled` 区块加一条覆写：内部置透，宿主用
  `oklch(from <源色> l c h / var(--bg-code-alpha))` 刷**一层**。保留源色色相（如终端主题色
  走 `--terminal-bg`），只换 alpha。多层元素各刷一遍半透明会叠成不透明（diffs 踩过）。
- **新的独立区域确实需要自己的档位**（如输入框、代码块）→ 走 settings store 加字段完整流程
  （`state.md`），新增一个滑块 + 一个 `--bg-*-alpha` 变量，并在上表登记。不要私自派生
  「面板 alpha + 常数」的公式——低可见度下会封顶到 1，用户感知为功能失效。

改完在背景图开启状态下截图对比一次；`--bg-code-alpha` 默认 0.65，`useBackgroundImage`
只在主窗口 `App.tsx` 调用，设置窗口不挂背景。

## 尺寸惯例

设置页密集列表的常用值，保持一致：

| 场景 | 类 |
|------|-----|
| 列表行 | `px-3 py-2 rounded-md hover:bg-accent/50` |
| 紧凑子行（弹窗内） | `px-2 py-1.5 rounded-md` |
| 行内图标按钮 | `h-7 w-7`，图标 `h-3.5 w-3.5` |
| 徽章 | `text-[11px]` |
| 次要说明文字 | `text-muted-foreground text-xs` |
| 分组标题 | `font-medium text-sm` |

## 布局防溢出

弹性布局里，可伸缩的一侧要 `min-w-0`（否则 `truncate` 不生效），
固定的一侧要 `shrink-0`：

```tsx
<div className="flex items-center gap-2">
  <span className="shrink-0 font-medium">{name}</span>
  <span className="min-w-0 truncate text-xs">{longPath}</span>
</div>
```

窗口可拖拽区域用 `drag` / `no-drag`（见 `TitleBar.tsx` 与 dialog 的 `no-drag`），
交互元素必须在 `no-drag` 内，否则点不动。
