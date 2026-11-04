# Catppuccin

浅色是 Latte，深色是 Mocha。带 `themes/catppuccin.css`，安装或更新时要同意「修改界面样式：主题 CSS 可改变应用任意界面」。`permissions` 仍是空数组，样式能力不写进这个数组。主题键是 `enso.example.catppuccin/catppuccin`。

```bash
enso-server plugin install examples/plugins/theme-catppuccin
enso-server plugin enable enso.example.catppuccin
```

CSS 只选择 `data-enso` 锚点，颜色只用已经派生的变量。没有 `@import`，也没有远程 `url()`。它把输入框描边和圆角、代码块底色、用户消息气泡、工具行文字改掉。字段和锚点见 [主题](../../../docs/theming.md)。

色值来自 [palette.json](https://github.com/catppuccin/palette/blob/main/palette.json) 1.8.0 版。角色对照来自 [Style Guide](https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md)。`canvas` 用 Mantle，样式指南里的次级窗格，侧栏坐在上面。`surface` 用 Base，主背景。`sunken` 用 Surface 0。`border` 用 Overlay 0，终端样式里的非活动边框。`borderStrong` 用 Overlay 2，比分隔线再深一档，避免和「Subtle」抢同一个 Overlay 1。`textSubtle` 用 Overlay 1，样式指南的 Subtle。`accent` 用 Mauve。样式指南把链接定为 Blue。Enso 的 accent 会写成 `--brand`，链接会跟着变。要把链接留在 Blue，用主题 JSON 的 `tokens` 覆盖 `--brand`。

| 字段 | Latte | Mocha |
| --- | --- | --- |
| `canvas` | Mantle `#e6e9ef` | Mantle `#181825` |
| `surface` | Base `#eff1f5` | Base `#1e1e2e` |
| `sunken` | Surface 0 `#ccd0da` | Surface 0 `#313244` |
| `border` | Overlay 0 `#9ca0b0` | Overlay 0 `#6c7086` |
| `borderStrong` | Overlay 2 `#7c7f93` | Overlay 2 `#9399b2` |
| `text` | Text `#4c4f69` | Text `#cdd6f4` |
| `textMuted` | Subtext 1 `#5c5f77` | Subtext 1 `#bac2de` |
| `textSubtle` | Overlay 1 `#8c8fa1` | Overlay 1 `#7f849c` |
| `accent` | Mauve `#8839ef` | Mauve `#cba6f7` |
