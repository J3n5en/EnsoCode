# 实现记录

## 改动清单

**新增**
- `src/shared/localImage.ts` — local-image:// URL ↔ 本地路径双向转换 + 媒体扩展名白名单
- `src/main/services/localImageProtocol.ts` — 特权协议：本地媒体读盘（视频 Range 206）+ remote-fetch 远程代理
- `src/main/ipc/files.ts` — FILES_LIST_MEDIA（文件夹随机模式枚举）
- `src/renderer/components/app/BackgroundLayer.tsx` — 背景层（z-index:-10 + pointer-events:none）
- `src/renderer/hooks/useBackgroundImage.ts` — 前景透明化（挂类 + alpha 变量）

**修改**
- `src/main/index.ts` — 协议登记（ready 前）+ handler 注册（ready 后）
- `src/main/ipc/window.ts` — DIALOG_SELECT_FILE；`src/main/ipc/index.ts` — 注册 files 模块
- `src/preload/index.ts` — dialog.selectFile / files.listMedia
- `src/renderer/stores/settings/{types,index}.ts` — 13 个背景字段 + clamp setters + backgroundRefreshNonce
- `src/renderer/components/settings/AppearanceSettings.tsx` — 背景图设置区（开关/来源/滑块/填充方式）
- `src/renderer/components/chat/ChatView.tsx` — 两个根容器补 bg-background（跟随可见度 tint）
- `src/renderer/styles/globals.css` — `html.bg-image-enabled` 用 CSS 相对颜色重映射 --color-* 令牌
- `src/renderer/index.html` — CSP 放行 local-image:
- `src/shared/i18n.ts` — 中文词条

## 关键决策

1. **透明化走 CSS 相对颜色**（`oklch(from var(--background) l c h / α)`），只重映射
   `--color-*` 层不动原始令牌 —— 天然兼容 light/dark/sync-terminal（ghostty 任意主题），无循环引用。
2. **弹出层保底 alpha 0.92**、边框 +0.25，保可读性。
3. **跨窗口手动刷新**用持久化 nonce 搭 settings 多窗口同步广播，不新增 IPC。
4. 设置窗口不挂背景（hook 仅主窗口 App 调用）。

## 真机验证（CDP 9223 临时端口）

- 7/7 断言通过：类/变量注入、背景层 DOM、local-image 200、标题栏 alpha、关闭还原
- 设置窗口 UI 六行配置齐全；设置窗口本身不受透明化影响
- 可见度滑块 85%→30%：中间区域 tint alpha 0.15→0.7（修复过一轮：ChatView 原本无面板底色）
- 验证用临时改动（CDP 端口 9223、独立 userData）已还原；临时脚本/截图/userData 已删除

## 联调轮补充（用户真机试用后）

1. ChatView 两个根容器补 `bg-background`：中间区域此前无面板底色，可见度滑块对它无效
2. shiki 代码块：`html.bg-image-enabled .shiki` 以更高优先级 + !important 覆盖内联主题底色
3. @pierre/diffs：shadow 内 host/pre/gutter/行多层各刷 --diffs-bg，半透会叠成近乎不透明；
   改为 --diffs-bg 置全透 + 仅宿主元素刷一层半透底色（外部文档规则 > shadow :host）
4. 新增两个独立滑块：输入框不透明度（backgroundComposerOpacity，默认 0.6）、
   代码块不透明度（backgroundCodeOpacity，默认 0.65）——教训：派生公式
   「panelAlpha+0.3 封顶 1」在低可见度下退化成全不透明，用户感知为功能失效
5. 网络图预加载：new Image() 就绪后再切，remote-fetch 代理改 `public, max-age=86400`
   使预加载与 CSS background 共享缓存（刷新靠 URL 上的 _t nonce）

## 已知环境坑（本次联调消耗大量时间，记录备查）

- 本机 9222 被 WebView2/Edge 应用长期占用；dev CDP 端口冲突时 electron 只报
  一行 "Cannot start http server for devtools" 不会重试
- 打包版 EnsoCode 运行时与 `pnpm dev` 共用 userData 'enso-code' → 单实例锁直接杀掉 dev；
  联调时需临时换 userData（用完必须还原）
- vitest 全套跑时 trellisSubagentGuard/modelMeta/checkpoint 存在时序性抖动，孤立跑通过；
  src/agent checkpoint/backgroundTasks 的 5 个失败为存量问题（改动前即存在）

