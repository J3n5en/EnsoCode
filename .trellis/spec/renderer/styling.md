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
