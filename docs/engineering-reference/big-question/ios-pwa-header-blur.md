# iOS 独立 PWA 顶部模糊

## 症状

iOS 27 真机上，同一页面在 Safari 中正常，添加到主屏幕后聊天标题被顶部模糊覆盖。
header 没有 `filter` / `backdrop-filter`，`safe-area-inset-top` 为 0；只补实色背景无效。
展开侧栏后标题清晰，容易误判为侧栏标题有额外留白。

## 根因

问题位于 iOS 独立 PWA 窗口的顶部渲染，而非 header 自己的模糊样式。
固定层的背景和显隐会影响系统状态栏的取色及顶部效果。

真机等几何对照确认：不移动标题，仅将聊天根容器改为固定、不透明的页面层，
即可同时消除本例的标题模糊和顶部灰条。常驻透明遮罩虽然也能使标题清晰，
却会留下灰色状态栏，不能作为修复。

## 修法

仅在 `display-mode: standalone` 下，为 `.phone-chat-root` 设置
`position: fixed`、`inset: 0` 和 `background-color: var(--background)`。
保留原 header 高度、safe-area、消息区滚动和 iOS 原生键盘避让，不硬编码顶部补偿。

普通 Safari 页面不使用此固定定位：其布局视口可能高于工具栏之间的可视区域，
应继续沿用现有 `body: 100dvh` 布局。不要重新引入 JS 视口高度覆盖。

## 复发：WebView 偶发钻到状态栏下（iOS 27.2）

固定实色层修复后，iOS 27.2 真机上标题仍会间歇性模糊。Web Inspector 测得两种几何
（iPhone 17 Pro Max 竖屏，`viewport-fit=cover`）：

| 状态 | `innerHeight` | `safe-area-inset-top` | 标题 |
|---|---|---|---|
| 正常 | 894（状态栏在页面外） | 0 | 清晰 |
| 异常 | 956（铺满整屏） | 62 | 被系统模糊覆盖 |

异常态下固定实色层仍在（fixed、inset 0、实色背景），但无效；标题下移 12px、
header 改 sticky / fixed 贴顶实色条都无效。切后台再回来会恢复正常，触发条件未定位。

运行时去掉 `viewport-fit=cover`，WebView 立刻退回状态栏之下（894 / 0），标题清晰。
代价是 `env(safe-area-inset-bottom)` 归零，输入区压到 home 条圆角。

修法：`statusBarOverlap.ts` 只在 iOS 独立 PWA 竖屏、顶部安全区非零且页面铺满整屏时，
先把当前底部安全区写入 `--phone-safe-bottom`，再去掉 `viewport-fit=cover`；
`pb-safe` 取 `env()` 与该变量的较大值。正常态不改 viewport。键盘弹起时视口变矮，不会误判。

## 回归防线

- 真机检查独立 PWA 的标题清晰、状态栏底色正确，header 高度和文字位置不变。
- 开关侧栏后状态栏恢复正常，侧栏和遮罩的点击层级正确。
- 弹出键盘时输入区仍可见、可点击，与原布局几何一致；收起后恢复视口高度。
- 普通浏览器模式下聊天根容器不是固定定位；浅、深色主题下背景跟随主题。
- 异常态（页面铺满整屏、顶部安全区非零）自动退出 cover 后，标题清晰且底部输入区不压 home 条。
- WebKit 页面截图不包含原生状态栏，不能单靠它判定模糊消失；需原生截图或真机目视。

## 相关代码

- [ChatScreen.tsx](../../../packages/phone/src/ChatScreen.tsx)
- [styles.css](../../../packages/phone/src/styles.css)
- [SessionDrawer.tsx](../../../packages/phone/src/SessionDrawer.tsx)
- [statusBarOverlap.ts](../../../packages/phone/src/statusBarOverlap.ts)
