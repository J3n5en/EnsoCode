# 终端图标字体

`EnsoNerdSymbolsMono-Regular.ttf` 基于 [Nerd Fonts v3.4.0 的 SymbolsNerdFontMono-Regular.ttf](https://github.com/ryanoasis/nerd-fonts/tree/v3.4.0/patched-fonts/NerdFontsSymbolsOnly)，采用 [MIT 许可证](../../public/fonts/LICENSE-Nerd-Fonts.txt)。许可证随 renderer 的 public 资源进入安装包。

上游原文件 SHA-256：`f0f624d9b474bea1662cf7e862d44aebe1ae1f6c7f9cb7a0ca5d0e5ac9561c60`。

应用派生字体 SHA-256：`89521d321efaf093dcb55065227041d8c58d983b35d18bfc10e2bd5b19224fe6`。

上游 symbols-only 字体的图标 advance 是 1em，约为 Consolas 单列宽度的两倍。xterm DOM renderer 会减小字距来匹配列宽，但不会缩放轮廓，后续单元格的背景会盖住右半图标。派生字体将 advance 和图标宽度限制到 0.55em，普通图标等比例缩放并保持居中，避免横向挤压；Powerline 分隔符保留整行高度、横跨整列，保留少量越界避免接缝。

使用 Python 和 `fonttools==4.60.1` 从上游原文件重建：

```text
python scripts/prepare-terminal-font.py <SymbolsNerdFontMono-Regular.ttf> src/renderer/assets/fonts/EnsoNerdSymbolsMono-Regular.ttf
```

`terminalFontAsset.test.ts` 直接解析 CSS 引用的字体，检查实际提示符图标、Powerline 和补充平面字形的存在、字宽及轮廓边界，防止重新引入超宽资产。

应用以 `Enso Nerd Symbols` 注册此字体，CSS 仅允许 Unicode 私用区字形参与终端渲染。字体位于用户文字字体之前，确保 PowerShell、Oh My Posh 和 Powerline 的图标可用，普通文字与中英文仍使用用户配置的字体。Vite 通过 CSS 资源引用将字体一起打包，运行时不依赖系统安装或网络下载。
