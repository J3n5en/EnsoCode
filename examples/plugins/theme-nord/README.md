# Nord

只贡献调色板，没有 `css`。安装时不会出现「修改界面样式」。主题键是 `enso.example.nord/nord`。

从设置里安装这个目录，或在仓库根执行：

```bash
enso-server plugin install examples/plugins/theme-nord
enso-server plugin enable enso.example.nord
```

然后在外观页选 Nord。字段含义见 [主题](../../../docs/theming.md)。

色值来自 Nord 官方文档 [Colors and Palettes](https://www.nordtheme.com/docs/colors-and-palettes)。浅色用文档里的 dark to bright：nord4 做底，nord6 做抬起的界面。深色用 Polar Night 做底、Snow Storm 做字。accent 两种模式都是 nord8，文档里的主强调色。

官方没有单独的「更强描边」。浅色 `borderStrong` 用了 nord3，亮色里最浅的 Polar Night，让输入框比卡片分隔线深一档。深色 `border` 用 nord2，因为 nord1 已经用作卡片底，同一颜色的线会看不见。深色 `sunken` 与 `canvas` 同为 nord0，代码块相对 nord1 卡片凹下去，这是文档里编辑区背景的用法。

| 字段 | 浅色 | 深色 |
| --- | --- | --- |
| `canvas` | nord4 `#d8dee9` | nord0 `#2e3440` |
| `surface` | nord6 `#eceff4` | nord1 `#3b4252` |
| `sunken` | nord5 `#e5e9f0` | nord0 `#2e3440` |
| `border` | nord4 `#d8dee9` | nord2 `#434c5e` |
| `borderStrong` | nord3 `#4c566a` | nord3 `#4c566a` |
| `text` | nord0 `#2e3440` | nord6 `#eceff4` |
| `textMuted` | nord1 `#3b4252` | nord5 `#e5e9f0` |
| `textSubtle` | nord3 `#4c566a` | nord4 `#d8dee9` |
| `accent` | nord8 `#88c0d0` | nord8 `#88c0d0` |
