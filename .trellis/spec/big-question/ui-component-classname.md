# Input 的 className 落在包裹层

## 症状

给带图标的搜索框传 `className="pl-8"` 给图标腾位置，结果输入框左边空出一大片，
文字看起来几乎居中，而**图标根本看不见**。

## 根因（两个问题叠加）

### 1. className 落在外层 span

`src/renderer/components/ui/input.tsx` 渲染的是两层结构：

```tsx
<span className={cn('relative inline-flex w-full rounded-lg border ...', className)}>
  <InputPrimitive className="h-8.5 w-full px-[calc(--spacing(3)-1px)] ..." />
</span>
```

边框在**外层 span** 上，`className` 也合并到这一层。所以 `pl-8` 撑的是
span 的内边距，把整个 `<input>`（连同它自己的 `px-3`）往右推了 2rem ——
视觉上就是一大片留白。

### 2. 图标被输入框背景盖住

图标绝对定位写在 `<Input>` **之前**：

```tsx
<div className="relative">
  <Search className="absolute left-2.5 ..." />   {/* 先 */}
  <Input />                                       {/* 后 */}
</div>
```

两者都是定位元素且都没有 z-index，同层叠上下文里**后来的覆盖先来的**，
而 `Input` 外层 span 带 `bg-background` 不透明背景，正好把图标盖住。

所以留白处什么都没有，看起来就像"莫名其妙的 padding"。

## 修法

```tsx
<div className="relative min-w-0 flex-1">
  <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
  <Input
    value={filter}
    onChange={(e) => setFilter(e.target.value)}
    className="h-8 text-xs [&_input]:pl-8"
  />
</div>
```

两处关键：

- **`[&_input]:pl-8`** 穿透到内部 `<input>`，而不是撑外层容器
- **`z-10`** 让图标浮在输入框背景之上（`pointer-events-none` 避免挡住点击）

## 判别规则

| 想改什么 | 怎么传 |
|----------|--------|
| 边框、背景、高度、字号、宽度 | 直接传：`className="h-8 text-xs"` |
| 内部输入区的内边距 | 子选择器：`className="[&_input]:pl-8"` |

写在 `Input` **之后**的元素（如 API Key 的眼睛按钮）不需要 z-10，天然在上层。

## 同类问题

`components/ui/field.tsx` 的 `Field` 是 `flex flex-col items-start`，
子元素不会自动撑满。`Field` 里自写的 div 都要显式 `w-full`，
否则宽度会收缩到内容宽度。

排查这类问题最快的方式是读**计算样式**而不是猜：
用 CDP 取 `getComputedStyle(input).paddingLeft` 和 `getBoundingClientRect()`，
一眼就能看出 padding 加在了哪一层。
