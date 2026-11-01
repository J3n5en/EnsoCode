# Enso 插件示例

完整的清单字段、接口、挂点和错误码见 [插件开发文档](../../docs/plugins.md)。

每个目录是一个可直接安装的插件：设置 → 插件 → Enso plugins → 安装目录；
服务端用 `enso-server plugin install examples/plugins/<name>`，再 `enso-server plugin enable <id>`。

| 目录 | 演示 | 权限 |
| --- | --- | --- |
| `word-stats` | Agent 工具读项目文件、工具结果卡片、` ```<pluginId>:bars` 代码块、随插件下发的 skill | `agent.tool` `fs.read` `ui.slot` |
| `snippets` | `#` 补全、输入框右侧按钮、消息操作按钮，读写当前草稿 | `ui.slot` `composer.draft` |
| `notes` | 侧栏页面（sandbox iframe）+ 插件私有数据目录，笔记一键插入输入框 | `ui.view` `composer.draft` |
| `github-repo` | Agent 工具经 `net.fetch` 访问白名单域名，系统通知 | `agent.tool` `net.fetch` `ui.notify` |
| `prompt-enhance` | 移植自 [dsh-bce](https://github.com/linqiu919/dsh-bce)：输入框左侧按钮调用已配置的 bce-tool MCP 索引项目并改写草稿，可恢复原文；演示宿主 MCP、长耗时方法、配置项、渲染模块直接改草稿 | `ui.slot` `composer.draft` `mcp.call` |
| `digest` | 会话开始事件、常驻、定时任务、工具进度与产出文件 | `agent.tool` `agent.observe` `process.background` |

## 结构

```text
enso-plugin.json   清单（必需）
main.mjs           插件进程入口，导出 activate(enso)；工具、补全、界面调用都在这里处理
ui.js              可选，主界面里运行的渲染模块，导出 onLoad(enso) 登记挂点
*.html             可选，侧栏页面，自包含（内联脚本与样式），经 window.enso.call 调 main
skills/            可选，随插件下发给新会话的 skill
```

## 运行环境要点

- `main.mjs` 跑在独立子进程里，是完整的 Node，不继承 EnsoCode 的环境变量；
  `enso.fs` / `enso.net` / `enso.composer` 等宿主接口按清单权限逐次校验。
- `enso.fs` 的路径相对当前会话的项目根，范围由 `fs.read` / `fs.write` 声明（`.` 表示整个项目）。
- 读写草稿只能发生在用户操作触发的调用里（按钮、补全选中、侧栏页面），30 秒内有效。
- `ui.js` 在主界面里运行，与 EnsoCode 同权，只适合你信任的插件；用 `enso.React` 写组件，
  样式用 CSS 变量（`var(--border)`、`var(--muted-foreground)` 等）跟随主题。
- 侧栏页面在 `sandbox="allow-scripts"` 的 iframe 里运行，不能访问网络与外部资源，
  只能通过 `window.enso.call(method, args)` 调本插件 `enso.renderer.handle` 注册的方法。

## prompt-enhance 的前置条件

在 设置 → MCP 里添加 bce-tool 并启用，例如命令 `npx`，参数
`-y bce-tool --base-url https://your-bce-host --token *** --no-webbrowser-enhance-prompt`
（非 Git 项目再加 `--allow-non-git`）。桌面版的 `npx` 最好写绝对路径。
BCE 地址和 token 只留在这条 MCP 配置里，插件读不到。有多个提供 `enhance_prompt` 的服务时，
可以在插件配置里填 `server` 指定用哪个。
