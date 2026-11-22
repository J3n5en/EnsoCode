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
应继续沿用现有 `body: 100dvh` 布局。不要重新引入「按比例猜键盘、把高度钉成像素」的 JS 视口覆盖。

## 键盘避让（keyboard.ts）

早期用 `visualViewport.height < innerHeight * 0.85` 猜键盘并覆盖 `--app-height`，standalone 下
误判后把高度钉死，输入框下方大片空白，最终整套移除。现在的 `packages/phone/src/keyboard.ts`
只在三个条件同时成立时生效：触屏（`hover: none` 且 `pointer: coarse`）、确有可编辑元素聚焦
（穿过完整版的 renderer iframe 查）、可见区比布局视口矮 120px 以上且没在缩放。生效时只加
`html.kb-open` 和 `--kb-top` / `--kb-height`，把根容器（精简版 `.phone-app-root`、完整版 `#frames`）
摆到可见区上；任何一条不成立立即去掉 class 和变量，并把 iOS 留下的上推滚动归零。
原有 `100dvh`、standalone 固定层、安全区规则都不改。焦点事件不冒泡出 iframe，完整版每次 iframe
加载都要重新挂监听。Chromium 没有软键盘，只能用替身 `visualViewport` 验证，iOS 必须真机看。

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

## 桌面模式（desk 壳）同源问题

desk 壳启动画面写死深色，状态栏在启动时按它采样后不再重采，所以上边缘一直是黑的；
后续改 body 底色、theme-color 都无效。修法：`desk/chrome.ts` 记下 renderer 上下边缘实际底色，
`desk.html` 头部内联脚本在首帧前铺上（无缓存时按系统深浅色）。键盘弹起时页面上推露出画布色，
所以 html 也要铺底（下边缘色）。主题切换后需重开 PWA 才更新状态栏，同手机版。

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
