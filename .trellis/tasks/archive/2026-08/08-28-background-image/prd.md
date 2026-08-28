# 透明背景图功能（移植自 EnsoAI）

## 背景

参考 D:\WORK\EnsoAI 的背景图功能（源头思路来自 vscode-background-cover），在 EnsoCode 主窗口实现"透明背景图"：
背景图铺在最底层，前景面板（标题栏/侧栏/聊天区等）变为半透明，从而"透出"背景图。

## 核心机制

- **不是透明窗口**：BrowserWindow 保持不透明。
- 渲染分三层：
  1. `BackgroundLayer`：绝对定位、`z-index:-1`、`pointer-events:none` 的背景层（CSS background-image 或 `<video>`）。
  2. 前景透明化：启用时给 `<html>` 加 `bg-image-enabled` 类，globals.css 中用 CSS 相对颜色语法
     `oklch(from var(--background) l c h / var(--panel-alpha))` 重映射 `--color-background/card/popover/muted/accent/secondary/border/input`，
     天然兼容 light/dark/sync-terminal（ghostty 主题）所有主题来源。
  3. `--panel-alpha = 1 - backgroundOpacity`，由 hook 内联写入；popover 有最低可读性 alpha 保护。
- 本地图片经自定义特权协议 `local-image://`（主进程 protocol.handle）加载；
  远程 URL 经 `local-image://remote-fetch?url=...` 主进程代理（绕过 CSP/CORS）。

## 配置项（zustand settings store，持久化到 settings.json）

| 字段 | 类型 | 默认 |
|---|---|---|
| backgroundImageEnabled | boolean | false |
| backgroundSourceType | 'file'\|'folder'\|'url' | 'file' |
| backgroundImagePath / backgroundFolderPath / backgroundUrlPath | string | '' |
| backgroundRandomEnabled | boolean | false |
| backgroundRandomInterval | number 秒 (5–86400) | 300 |
| backgroundOpacity | 0–1 | 0.85 |
| backgroundBlur | 0–20 px | 0 |
| backgroundBrightness / backgroundSaturation | 0–2 | 1 |
| backgroundSizeMode | 'cover'\|'contain'\|'repeat'\|'center' | 'cover' |
| backgroundRefreshNonce | number | 0（手动刷新用，跨窗口经 settings 同步广播） |

## 改动面

- shared: `fileUrl.ts`（路径↔local-image URL）、IPC 通道（DIALOG_SELECT_FILE、FILES_LIST_MEDIA）、i18n zh 词条
- main: local-image 协议模块 + index.ts 接线；window.ts 加选文件对话框；agent.ts 旁加 listMedia
- preload: dialog.selectFile / files.listMedia
- renderer: settings store 字段 + setters；BackgroundLayer 组件；useBackgroundImage hook；
  App.tsx 挂载；AppearanceSettings 背景图设置区；globals.css bg-image-enabled 规则；index.html CSP

## 验收标准

1. 设置 → 外观 → 背景图：开关、来源（单图/文件夹随机/URL）、可见度/模糊/亮度/饱和度滑块、填充方式。
2. 主窗口开启后能看到背景图透出，UI 可正常交互（背景层不拦截事件）。
3. 文件夹模式支持定时随机换图与手动刷新；设置窗口修改后主窗口实时生效（多窗口同步）。
4. 关闭后完全还原原有外观。
5. `pnpm typecheck` / lint 通过。
