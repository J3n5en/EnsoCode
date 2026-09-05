# 流式 Markdown 代码块闪烁

## 问题

助手消息还在流式输出时，已经画出来的代码块（浅灰圆角边框）会一明一亮地闪。截图里的树状结构 / 目录结构块都是这个现象。

## 根因

`Markdown` 每次渲染都新建 `components` 对象，`pre` 是新的匿名函数。`react-markdown` 把它当组件类型，类型一变 React 就卸载重挂 `CodeBlock`。

`CodeBlock` 挂载时 `html === null`，先画 `bg-muted/50` 回退；`codeToHtml`（shiki，`github-light` / `github-dark` 实心底）一回来又换成另一套底色。流式每帧都走一遍，就是明暗闪。

整条消息 `streaming=true` 时，已经闭合的围栏也会反复高亮，白白烧 CPU。

## 目标

流式过程中代码块底色稳定，不再在回退样式和 shiki 主题之间来回切。流结束后再高亮一次。

## 方案

1. `Markdown` 的 `components` 提到模块级稳定引用；`streaming` / 搜索 / 原文用 context 传，避免 `pre` 类型每帧换身份。
2. `CodeBlock` 在 `streaming` 时不跑 shiki，只画回退 `<pre>`（与 `MermaidRenderer` 一致）。

## 验收

- 消息仍在流、围栏已闭合时，代码块不再明暗闪。
- 流结束后代码块照常语法高亮、可复制。
- 不改行内 code、表格、alert、mermaid 的既有语义。

## 不做什么

- 不改 shiki 主题或全局 CSS 配色。
- 不给 React 组件加单测（spec 明确暂未覆盖）。
