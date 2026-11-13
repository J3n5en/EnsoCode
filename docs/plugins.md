# 编写 Enso 插件

插件是一个带 `enso-plugin.json` 的目录。安装后 Enso 把它复制到自己的数据目录里运行，不引用原路径。

可以参考的完整例子在 [`examples/plugins/`](../examples/plugins/README.md)：`word-stats`（工具、结果卡片、代码块、skill）、`snippets`（补全、按钮、改草稿）、`notes`（侧栏页面、私有数据）、`github-repo`（网络请求、系统通知）、`prompt-enhance`（移植自 dsh-bce：调用宿主 MCP、长耗时方法、配置项、渲染模块直接改草稿）、`theme-nord`（只提供调色板）、`theme-catppuccin`（调色板加 CSS）。

## 安装与管理

- 桌面：设置 → 插件 → Enso plugins → 安装目录。
- 桌面也可以粘贴链接安装：http(s) 的 zip，或 GitHub 仓库（`https://github.com/owner/repo`；仓库里的子目录用 `.../tree/分支/子目录`）。本机下载 zip 后复制进数据目录。私有仓库不支持。
- 服务端：`enso-server plugin install <目录、zip 或 http(s) 链接>`，确认后 `enso-server plugin enable <id>`。
- 新装的插件默认停用，需要手动启用。
- Enso 记住每个插件最近一次的安装来源（目录、zip 路径或链接）。设置页插件行的「从来源重新安装」或 `enso-server plugin reload <id>` 会重新读取来源，走和更新一样的确认流程。链接安装的插件用它拉取新版；开发插件时从源目录安装，改完代码用它重新加载。
- 检查更新：从 GitHub 仓库链接安装的插件，Enso 启动后约 1 分钟检查一次、之后每天一次（只查已启用的），只拉仓库里的 `enso-plugin.json` 比较 `version`，不下载整包、不自动安装。有新版本时设置页插件行会提示，点「更新」走上面的确认流程；也可以点「检查更新」或用 `enso-server plugin check` 立即检查。版本号按 semver 比较，作者不改 `version` 就不算新版。普通 zip 链接不自动检查，只能手动重新安装。重新安装时新包版本没变或更低，预览里会提示。
- 同 id 再装一次按更新处理。权限没有变大就直接换新版；权限变大则旧版继续运行，需要 `enso-server plugin approve <id>`（或设置页同意）才切到新版，`reject` 则留在旧版。
- 插件系统正式发布前登记格式可能变更且不做兼容：启动时读到旧格式或字段不全的登记记录会丢弃，并清理这些插件的包、数据、配置、产出、页面状态和日志。设置页和 `enso-server plugin list` 会列出被丢弃的插件 id，重新安装后自动消失；提示保存在磁盘上，重启不会丢，点「知道了」或 `enso-server plugin notice-dismiss` 清除。
- 登记表本身读不出（不是 JSON 或结构不对，比如磁盘损坏、同步冲突、手改）时不删除任何插件文件：原文另存为数据目录下的 `extension-plugins/registry.json.unreadable`，插件列表暂时为空，设置页和 `plugin list` 会提示。每次写登记表前还会把上一份留成 `registry.json.bak`。磁盘上有包目录、登记表里却没有的插件只记日志，不自动删除。
- 10 分钟内非预期崩溃 3 次，插件会被自动停用，状态变成 `crashed`，重新启用即可。停用原因会显示在设置页和 `enso-server plugin list` 里。
- 日志：`main.mjs` 里的 `console.*` 输出、处理器抛出的异常和进程意外退出都会记下来，在设置页插件行的日志按钮或 `enso-server plugin logs <id>` 里看。单个日志文件超过 1MB 轮转一次，卸载时删除。每个插件每秒最多落盘 100 行，超出的直接丢弃，并额外记一条「已丢弃 N 行」。
- 远程使用：手机 PWA 的完整模式跑的是同一套界面，插件的挂点、补全、命令和侧栏页面都能用；安装、启停、授权、配置、看日志和重新安装只能在本机界面或服务端 CLI 上做。手机精简模式不加载插件界面，插件工具仍由桌面端的 Agent 正常调用。
- 有配置项的插件：设置页插件行的齿轮按钮，或 `enso-server plugin config <id>`（查看）/ `enso-server plugin config <id> key=value`（设置；`key=` 留空会在终端里提示输入，不进 shell 历史；`--unset key` 清除）。

### 开发工具

- 开发模式：从目录安装的插件，在设置页插件详情里打开「开发模式」，或 `enso-server plugin dev <id>`（`dev-off` 关闭）。目录里的文件改动停下约 400ms 后自动从来源重装；隐藏文件、`node_modules` 和 zip 的改动不算。授权没变大时直接替换，变大时停下并在插件行显示错误，需要「从来源重新安装」走确认。开关只在内存里，重启后关闭。
- 打包：`enso-server plugin pack <目录> [--out <zip>]` 先按安装时的规则校验清单，再把目录打成 zip，排除隐藏文件、`node_modules`、`test/`、zip 和 `enso-testing.mjs`。条目按路径排序、时间戳固定，同样的内容得到同样的 sha256，输出里给出大小和哈希。
- 测试：`enso-server plugin testing <目录>` 写入零依赖的 `enso-testing.mjs` 和示例 `test/main.test.mjs`。`mountMain(activate, { config?, host? })` 用一个假的 `enso` 调起 `activate`，返回 `tool(name, args, ctx?)`、`command(id, ctx?)`、`fire(event, data, ctx?)`、`schedule(id)`、`method(name, args, ctx?)`、`turnEnd(sessionId)` 去调注册的处理函数；宿主调用记在 `calls` 里（如 `{ api: 'ui.status.update', args }`），返回值由 `host['ui.status.update']` 这样的函数提供。在插件目录运行 `node --test`。

## 清单 `enso-plugin.json`

不超过 256KB，必须是 JSON 对象，`schemaVersion` 固定为 `1`。未知字段会被忽略并给出警告。

```json
{
  "schemaVersion": 1,
  "id": "enso.example.notes",
  "name": "Notes",
  "version": "1.0.0",
  "description": "侧栏便签",
  "icon": "icon.svg",
  "engines": { "enso": ">=0.2.0" },
  "main": "main.mjs",
  "renderer": "ui.js",
  "permissions": ["ui.view", "composer.draft"],
  "fs": { "read": ["."], "write": ["notes"] },
  "net": { "domains": ["api.github.com"] },
  "mcp": { "tools": ["enhance_prompt"] },
  "contributes": {
    "agentTools": [],
    "commands": [],
    "views": [{ "id": "notes", "title": "Notes", "entry": "notes.html" }],
    "triggers": [{ "symbol": "#", "name": "snippets" }],
    "skills": ["skills/bar-chart"],
    "mcpServers": [],
    "presets": [
      {
        "id": "review",
        "name": "Review",
        "skills": ["skills/bar-chart"],
        "mcpServers": [],
        "instruction": "prompts/instruction.md",
        "systemPrompt": "prompts/role.md"
      }
    ],
    "agentTypes": [
      {
        "name": "notes:reviewer",
        "description": "只读审查便签相关改动",
        "systemPrompt": "agents/reviewer.md",
        "tools": "readonly",
        "skills": ["skills/bar-chart"]
      }
    ],
    "methods": [{ "name": "enhance", "timeoutMs": 120000 }],
    "configuration": [{ "key": "token", "title": "Token", "secret": true }]
  }
}
```

| 字段 | 要求 |
| --- | --- |
| `id` | 反向域名，`^[a-z][a-z0-9]*(\.[a-z0-9]+)+$`，最长 40 字符 |
| `name` | 非空，最长 60 字符 |
| `version` | 非空，最长 40 字符 |
| `description` | 可选 |
| `icon` | 可选，插件目录内的图片相对路径（svg / png / jpg / webp），用于设置页、侧栏标签和插件消息；缺省显示拼图图标 |
| `engines.enso` | 可选，只支持 `>=x.y.z`；宿主机版本不够则拒绝安装 |
| `main` | 可选，插件目录内的相对路径。声明了工具、命令、补全来源、方法或配置项时必填 |
| `renderer` | 可选，渲染模块的相对路径 |
| `permissions` | 见下表，重复项自动去重 |
| `fs.read` / `fs.write` | 相对项目根的目录范围，`.` 表示整个项目。填了就必须申请对应权限 |
| `net.domains` | 主机名，如 `api.github.com`，不含协议和路径。填了就必须申请 `net.fetch` |
| `mcp.tools` | 允许调用的宿主 MCP 工具名（字母、数字、`_ . -`，最长 64）。填了就必须申请 `mcp.call`，申请了 `mcp.call` 也必须填 |
| `resident` | 可选，`true` 表示常驻：启用即拉起进程，不因空闲退出。需要 `process.background` |
| `env` | 可选，额外透传给插件进程的环境变量名，最多 20 个。不能是 `ENSO_*`、`ELECTRON_*`、`LD_*`、`DYLD_*`、`NODE_OPTIONS`、`NODE_PATH`、`NODE_EXTRA_CA_CERTS` |
| `interop.call` | 可选，允许调用的其他插件 id。填了就必须申请 `plugin.call`，申请了也必须填 |

路径一律是插件目录内的相对路径：不能是绝对路径、不能含 `..`、不能含反斜杠。

### 权限

声明了某项贡献就必须申请对应权限，否则拒绝安装。主题不在此列，见本表后面的样式能力。

| 权限 | 何时需要 | 允许做什么 |
| --- | --- | --- |
| `agent.tool` | 有 `agentTools` | 注册 Agent 工具 |
| `ui.slot` | 有 `renderer` 或 `triggers` | 渲染模块、补全来源 |
| `ui.view` | 有 `views` | 侧栏页面，以及 `enso.ui.view.emit` |
| `ui.notify` | 要发系统通知 | `enso.ui.notify` |
| `composer.draft` | 要读写输入框 | `enso.composer.*` |
| `fs.read` / `fs.write` | 声明了对应范围 | 读写当前会话的项目文件 |
| `net.fetch` | 声明了域名 | 访问这些域名 |
| `mcp.server` | 有 `mcpServers` | 随会话拉起 MCP 服务 |
| `mcp.call` | 有 `mcp.tools` | 调用用户已配置的 MCP 服务里、清单列出的工具 |
| `agent.observe` | 有通知型 `events` | 收到会话事件 |
| `agent.intercept` | 有拦截型 `events` | 拦截并改写工具调用、工具结果和用户输入 |
| `agent.inject` | 要向会话发消息 | `enso.session.inject` / `enso.session.abort`：向会话发送消息（可带图片）、触发或中止该会话的执行。默认只能发到发起调用的会话；用户单独允许后可发到任意运行中的会话 |
| `process.background` | `resident` 或有 `schedules` | 常驻进程、定时任务 |
| `plugin.call` | 有 `interop.call` | 调用其他插件导出的方法 |
| `ui.clipboard` | 要写剪贴板 | `enso.ui.clipboard.writeText` |
| `ui.openExternal` | 要打开外部链接 | `enso.ui.openExternal` |
| `session.read` | 要列出会话、读会话状态或得知回合结束 | `enso.session.list` / `enso.session.status` / `enso.session.onTurnEnd`，限本项目 |
| `session.readAll` | 要看所有项目的会话 | `enso.session.list({ scope: 'all' })`，`enso.session.status` 可查任意项目的会话；涵盖 `session.read` |
| `session.focus` | 要切换到会话 | `enso.session.focus` |
| `session.create` | 要新建会话 | `enso.session.create` |

主题的 CSS 不进上表，也不要往 `permissions` 里写一个样式权限，未知名字会被拒绝。任一 `themes` 项带了 `css`，安装和更新对话框会多出「修改界面样式：主题 CSS 可改变应用任意界面」。这项从无到有时要重新同意。只提供调色板的主题没有这项。调色板、派生变量和锚点见 [主题](theming.md)。

升级时如果权限、文件范围、域名、MCP 工具、透传变量、可调用的插件、拦截事件变多，改成常驻，或新带了 `renderer`，需要重新确认。

安装时展示的是这些权限，但插件的 `main` 本身是完整的 Node 进程，权限只约束它能向 Enso 申请的能力，不约束它自己的代码。只安装你信任的插件。

## 依赖

Enso 安装插件时只复制目录，不会执行 `npm install`，也不会在用户机器上编译任何东西。插件需要的依赖必须由作者打包进插件里。

推荐的做法是把 `main.mjs` 和依赖用 esbuild 或 webpack 打成单个文件再发布，仓库里不提交 `node_modules`。这样更新时 diff 干净，也不用担心依赖的体积和文件数。

依赖不适合打包、只能原样带上时（例如要在运行时按相对路径读取的 wasm），可以把 `node_modules` 放进插件目录一起发布。发布前确认里面没有 `.node` 原生模块：原生模块绑定了操作系统、CPU 架构和编译时的 Node ABI，在开发者机器上装出来的，换个平台或架构就加载不了，Enso 也不会重新编译。纯 JS 和 wasm 没有这个问题。

无论哪种方式，插件包都受 5000 个文件、合计 200MB 的限制。依赖多的时候，文件数通常比体积先到上限。

### 贡献

- `agentTools`：`{ name, description, parameters, timeoutMs?, readOnly? }`。`timeoutMs` 是 1000 到 600000 的整数，缺省 60 秒。`readOnly: true` 声明这个工具不改动任何东西（只查询），宿主不核实；模型只用过只读工具的一轮可以用 `turn_discard` 丢弃，写操作或发消息的工具不要标。`name` 匹配 `^[a-z][a-z0-9_]*$`，不能含 `__`。`description` 最长 1024 字符。`parameters` 必须是 `type` 为 `object` 的 JSON Schema。模型看到的工具名是 `plugin_<id>__<name>`，其中 id 的 `.` 换成 `-`，总长不超过 64 字符。
- `commands`：`{ id, title, key? }`。`id` 匹配 `^[a-z][a-z0-9-]{0,31}$`。启用后出现在输入框的 `/` 菜单里，名字是 `/<插件 id>:<命令 id>`，选中立即执行，不进草稿也不发消息。执行算用户操作，可以改草稿；侧栏等独立输入框里 `ctx.sessionId` 为 `null`。失败时界面提示错误信息。
  - `key` 是默认快捷键，如 `mod+shift+k`：修饰键按 `mod`、`ctrl`、`alt`、`shift` 顺序写，至少一个不是 `shift`；`mod` 在 macOS 是 ⌘，其他平台是 Ctrl。按下时对当前会话执行，`ctx.sessionId` 为当前标签的会话。内置快捷键优先，多个插件抢同一个键时先装的生效；用户可以在设置的快捷键页改键或删除。
- `views`：`{ id, title, entry }`。`title` 最长 40 字符，`entry` 必须是 `.html`。
- `fileViewers`：`{ id, title, entry, extensions, default? }`，需要 `ui.view`。`extensions` 是 1 到 32 个小写、带点的后缀，如 `.csv`、`.excalidraw.json`；`default: true` 时匹配的文件默认用它打开，否则只在文件标签右上角给出切换按钮。见下文「文件查看器」。
- `statusItems`：`{ id, text, tooltip?, command? }`，最多 8 个，不需要权限。显示在主输入框底栏右侧，`text` 最长 24 字符，`tooltip` 最长 200。`command` 是本插件 `commands` 里的 id，点击时对当前会话执行。见下文「状态项」。
- `triggers`：`{ symbol, name }`。`symbol` 只能是 `#`，`@` 和 `/` 归 Enso 自己用。
- `skills`：skill 目录的相对路径，随插件下发给新会话。
- `mcpServers`：`{ name, command, args, env }`。服务名会加 `plugin-<id>-` 前缀。`command`、`args`、`env` 里的 `${ENSO_PLUGIN_ROOT}` 会展开成插件安装目录，`env` 只能写字面量。
- `workflows`：workflow 预设文件的相对路径，必须是 `<id>.js`，文件名即预设 id（`^[a-z0-9][a-z0-9-]{0,63}$`），同一插件内不能重名。文件格式与 `~/.agents/workflows` 里的预设相同。会话的 `workflow` 工具和侧栏都能用到；同 id 时项目、设置、全局目录里的预设优先，插件预设优先于内置预设。
- `presets`：`{ id, name, skills, mcpServers, workflows?, agentTypes?, instruction?, systemPrompt?, systemPromptTail?, boostPrompt?, refusalRetry?, refusalRetryPrompt?, model?, thinkingLevel?, approvalMode?, disabledTools? }`，最多 20 个。`skills`、`mcpServers`、`workflows` 和 `agentTypes` 只能引用本插件已经声明的 skill 目录、MCP 服务名、workflow 文件和子代理类型名。指令和角色、真尾、boost、推脱补发都是插件目录里的 Markdown 文件。启用后出现在预设列表里，只读，不能在设置里改；用户也可以在自建预设的「高级」里叠加它。会话 id 是 `plugin:<插件 id>:<预设 id>`。`model` 是 `{ providerId, modelId }`，选中预设时输入框切到这个模型，模型不可用时会话启动失败；`thinkingLevel` 覆盖当前档位；`approvalMode` 只能是 `supervised` 或 `auto-edits`，和用户当前档位取更严的一个；`disabledTools` 并入禁用工具列表。
  - 全局还是预设专用：`skills`、`mcpServers`、`workflows`、`agentTypes` 里的条目没被任何预设列出时，对所有会话生效；被某个预设列出后，只在选中这个预设（或自建预设叠加了它）的会话里生效。
- `agentTypes`：`{ name, description, systemPrompt, tools?, skills? }`，最多 20 个，见下文「子代理类型」。
- `methods`：`{ name, timeoutMs }`，给 `renderer.handle` 注册的方法声明更长的超时，1000 到 120000 毫秒的整数。没声明的方法 2 秒超时。
- `configuration`：`{ key, title, description?, secret?, type?, default?, options?, min?, max?, pathKind? }`，最多 20 项。`key` 匹配 `^[A-Za-z][A-Za-z0-9_]{0,31}$`，`title` 最长 60 字符。`type` 是 `string`（缺省）、`number`（可带 `min` / `max`）、`boolean`、`enum`（必须带 `options`）或 `path`（可带 `pathKind: 'file' | 'directory'`）；只有 `string` 能设 `secret`。用户在设置页或命令行里填写，插件用 `enso.config.get()` 读取。
- `events`：`{ event, mode?, failClosed?, tools? }`，订阅会话事件，见下文「会话事件」。
- `schedules`：`{ id, intervalSeconds, timeoutMs? }`，最多 10 个。间隔 60 到 86400 秒，单次缺省 60 秒超时。
- `exports`：`{ name, timeoutMs? }`，允许其他插件调用的方法。
- `dynamic`：`{ tools?, commands? }`，运行期最多能额外注册多少工具（0–50）和命令（0–20），缺省都是 0。
- `themes`：`{ id, name, path, css? }`。一项一个主题。`id` 不含 `/`，并匹配 `^[a-z][a-z0-9-]{0,31}$`，和插件 id 组成 `<插件 id>/<主题 id>`。`path` 与可选的 `css` 是插件目录内的相对路径，规则与其他路径相同。`path` 必须以 `.json` 结尾，`css` 必须以 `.css` 结尾。见 [主题](theming.md)。

同一类贡献里的 `id` 或 `name` 不能重复。

## 类型

[`types/enso-plugin.d.ts`](../types/enso-plugin.d.ts) 从宿主实现再导出 `main.mjs`、`ui.js`、侧栏页面和清单的类型。引用这份声明，不要复制，否则会和实现脱节。

插件目录放 `jsconfig.json`，把 `enso-plugin` 指到仓库里的声明（路径按实际位置改）：

```json
{
  "compilerOptions": {
    "checkJs": true,
    "allowJs": true,
    "noEmit": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ESNext",
    "strict": true,
    "lib": ["ESNext", "DOM"],
    "jsx": "react-jsx",
    "skipLibCheck": true,
    "types": [],
    "paths": {
      "enso-plugin": ["../enso-code/types/enso-plugin.d.ts"]
    }
  },
  "include": ["main.mjs", "ui.js"]
}
```

```js
/** @param {import('enso-plugin').EnsoMain} enso */
export function activate(enso) {}

/** @param {import('enso-plugin').EnsoUi} enso */
export function onLoad(enso) {}
```

侧栏页面脚本里：

```js
/** @type {import('enso-plugin').EnsoView} */
const enso = window.enso;
```

清单用 `import('enso-plugin').EnsoPluginManifest`（作者写的 JSON，版本约束是 `engines.enso`）。解析之后的形状是 `ExtensionPluginManifest`（`ensoRange`）。

`enso-server plugin init <目录> [--id <id>]` 会生成带上述引用的最小插件。`enso-server plugin validate <目录>` 用同一套清单校验检查 `enso-plugin.json`，并确认 `main` / `renderer` 指向的文件存在；失败时错误打到 stderr，退出码为 1。

## `main.mjs`

导出 `activate(enso)`，Enso 在插件进程启动时调用它。非常驻插件的进程空闲 5 分钟后退出，下次调用时重新启动，所以不要依赖内存里的状态，要持久化就写 `enso.dataDir`。

可以再导出 `deactivate()`：停用、卸载、升级或 Enso 退出时调用，最多等 3 秒。之后经 `node:child_process` 拉起的子进程会被结束。

```js
export async function activate(enso) {
  enso.tools.register('count_words', async (args, ctx) => {
    const text = await enso.fs.readText(args.path);
    return { content: `${text.split(/\s+/).length} words` };
  });
}
```

`enso` 上的字段：

| 成员 | 说明 |
| --- | --- |
| `pluginId` | 清单里的 id |
| `dataDir` | 插件私有目录，卸载时删除。进程环境变量 `ENSO_PLUGIN_DATA` 指向同一位置 |
| `tools.register(name, handler, meta?)` | `handler(args, ctx)` 返回字符串，或 `{ content, details? }`。其它返回值会被序列化成 JSON 字符串。清单里没有的名字要带 `meta = { description, parameters, timeoutMs? }`，算动态工具，见下 |
| `commands.register(id, handler, meta?)` | `handler(ctx)`。清单里没有的 id 要带 `meta = { title }`，算动态命令 |
| `events.on(event, handler)` | 只能订阅清单 `events` 声明过的事件，见「会话事件」 |
| `schedules.register(id, handler)` | 只能注册清单 `schedules` 声明过的 id |
| `exports.handle(name, handler)` / `plugins.call(pluginId, name, args?)` | 见「插件间调用」 |
| `artifacts.write(input)` | 见「产出文件」 |
| `session.inject(input)` | 见「向会话发消息」 |
| `session.abort(sessionId?)` | 见「向会话发消息」 |
| `session.list(options?)` | 需要 `session.read`。返回 `{ current, sessions }`：`current` 是发起调用的会话 id（子会话为其 id，可用 `split('::')[0]` 取主会话），`sessions` 是同项目的主会话，按最近活动从新到旧，最多 200 条，每项 `{ id, title, updatedAt, state, running?, archived? }`，`state` 见「会话状态」。不含 Bot 会话与已结束的会话；某个 id 不在列表里即可视为已删除。`{ scope: 'all' }` 需要 `session.readAll`，列出所有项目的主会话（同样最多 200 条），每项多带 `projectId` 和 `projectName`（项目目录名）；不在宿主发起的调用里（如常驻进程）也能用，此时 `current` 为 `null` |
| `session.status(sessionId?)` | 需要 `session.read` 或 `session.readAll`。缺省查发起调用的会话，返回 `{ sessionId, state, pendingAsks, pendingApprovals }`，见「会话状态」。查别的会话时，它须在 `session.list()`（或有 `session.readAll` 时在全局列表）里，否则 `NOT_FOUND` |
| `session.onTurnEnd(listener)` | 需要 `session.read` 或 `session.readAll`。主会话一轮结束时回调 `listener({ sessionId })`，返回取消订阅函数，见「回合结束」 |
| `session.focus(sessionId)` | 需要 `session.focus`。切换到同项目的会话（子会话切到所属主会话的对应标签）。只能在用户操作触发的调用里用（同草稿的 30 秒手势）；会话不在本项目返回 `NOT_FOUND` |
| `session.create({ text? })` | 需要 `session.create`。在发起会话的项目里新建会话并切过去，返回 `{ sessionId }`。`text`（不超过 32KB）只填进新会话的输入框，由用户确认后发送。只能在用户操作触发的调用里用 |
| `host.capabilities()` | 返回 `{ host: 'desktop' \| 'server', hostVersion, notify, mcp, clipboard, openExternal, composer }`，用来在桌面和服务端之间降级 |
| `triggers.register(name, handlers)` | `handlers.candidates(query, ctx)` 与 `handlers.pick(item, ctx)` |
| `renderer.handle(method, handler)` | 供渲染模块和侧栏页面调用，`handler(args, ctx)` |
| `fs.readText(path)` / `fs.writeText(path, text)` | 路径相对当前会话的项目根 |
| `net.fetch(url, init?)` | 见下 |
| `ui.notify(title, body?)` | 系统通知 |
| `ui.view.emit(name, data?)` | 推一条事件到本插件已打开的侧栏页面。需要 `ui.view`，不需要用户手势，也不需要在宿主发起的调用里，所以 Agent 工具、常驻进程和定时任务都能调。`name` 是小写字母开头、最长 64 的 `a-z` `0-9` `.` `_` `-`；`data` 须可 JSON 序列化，不超过 256KB。没打开侧栏时直接丢掉。每插件每秒最多 20 条 |
| `ui.view.open(viewId?)` | 打开当前会话的右侧栏并创建或聚焦本插件的侧栏页面（`viewId` 缺省取清单 `views` 的第一项）。需要 `ui.view`，不需要用户手势 |
| `ui.clipboard.writeText(text)` / `ui.openExternal(url)` | 写剪贴板、用系统浏览器打开链接。只能在用户操作触发的调用里用（同草稿的 30 秒手势）；链接只接受 `http`、`https`、`mailto`；剪贴板文本不超过 1MB |
| `composer.readDraft()` / `insertText(input)` / `replaceDraft(input)` | 见下 |
| `config.get()` | 本插件的配置值，按 `type` 返回字符串、数字或布尔值；未设置的键取 `default`，没有 `default` 就不出现。不需要权限，`activate` 里也能调 |
| `mcp.tools()` / `mcp.call(server, tool, args?)` | 见下 |

每次 `register` 都返回一个取消函数。`ctx` 含 `sessionId`（可能为 `null`）、`projectRoot`（当前会话的本机项目绝对路径，没有本机项目时为 `null`）、`agent`（来自子会话时的来源，主会话和非会话调用为 `null`，见「子代理与 coworker」）、`invocationId`、`signal`（调用被取消或超时时 abort）和 `progress(text)`（只在工具调用里有效，见下）。

插件进程不继承 Enso 的环境变量，只保留 `PATH`、`HOME` 等运行必需项、`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`（含小写写法）和清单 `env` 里声明的变量。上面这些宿主接口每次调用都回到主进程校验，校验失败抛带 `code` 的错误，见文末错误码。

### 工具返回值

`content` 是给模型看的文本，`details` 是任意 JSON，只给界面用（比如结果卡片）。整个结果不超过 1MB，单次调用按清单的 `timeoutMs` 限时，缺省 60 秒。工具调用走和 MCP 工具相同的审批，用户的审批档位同样生效。

耗时的工具可以调 `ctx.progress(text)` 上报进度，工具卡片会实时显示。每 200ms 最多生效一次，单条不超过 16K 字符。

### 动态工具与命令

清单 `dynamic` 给出上限后，插件可以在运行期用 `tools.register(name, handler, meta)` / `commands.register(id, handler, meta)` 注册清单里没有的工具和命令，名字规则与清单相同，`parameters` 必须是 `type` 为 `object` 的 JSON Schema，超出上限返回 `QUOTA`。返回的取消函数会把它们撤掉。动态工具对之后新开的会话生效：Enso 启动会话前会先拉起声明了动态工具的插件（最多等 5 秒）；加载失败会被记住，重新启用、升级或从来源重新安装后才再试。插件进程退出后，动态注册全部清空；插件仍启用时再调用，会先拉起进程、等它重新注册后再查一次，仍然没有才当作不存在。

### 会话事件

清单 `events` 里的每一项是 `{ event, mode?, failClosed?, tools? }`。`mode` 缺省 `observe`（只通知，需要 `agent.observe`），设为 `intercept` 时可以改写或拦下（需要 `agent.intercept`）。Bot 会话（含其子代理）不发事件；子代理与 coworker 只拦截 `tool_call`，其余只发通知，见「子代理与 coworker」。

| 事件 | 时机 | `data` | 可拦截 |
| --- | --- | --- | --- |
| `session_start` / `session_end` | 会话开始 / 结束 | `{ reason }` | 否 |
| `agent_start` / `agent_end` | 一轮回复开始 / 结束 | `agent_start`：`{}`；`agent_end`：`{ text }`，本轮最后一条助手回复的文字部分（不含思考与工具调用，最多 64K 字符，没有文字时为空串） | 否 |
| `before_compact` | 上下文压缩前 | `{ reason }` | 否。主会话只等已经在运行的插件（含常驻）处理完，最多 10 秒，然后照常压缩；没在运行的非常驻插件直接跳过，不会为此拉起进程。子会话里只通知、不等待 |
| `after_compact` | 压缩后 | `{ reason }` | 否 |
| `tool_call` | 工具执行前 | `{ toolCallId, toolName, input }` | 返回 `{ block: true, reason? }` 拦下，或 `{ input }` 改写参数 |
| `tool_result` | 工具执行后 | `{ toolCallId, toolName, input, content, isError }`。通知里的 `content` 最多 64K 字符，超出截断；拦截看到的是完整文本 | 返回 `{ content?, isError? }` 改写结果 |
| `input` | 用户发送消息时 | `{ text, source }` | 返回 `{ action: 'transform', text }` 改写，或 `{ action: 'handled' }` 吞掉这条消息 |
| `context_usage` | 上下文占用刷新时（回复开始、每条回复结束、压缩后、一轮收口） | `{ used, estimated, contextWindow?, percent?, buckets, usage?, parts?, turns? }` | 否 |
| `session_status` | 主会话的汇总状态或挂起的提问 / 审批数变化时，所有项目的会话都会发 | `{ sessionId, state, previous, pendingAsks, pendingApprovals }`，见「会话状态」 | 否 |
| `model_select` | 会话切换模型时（手动切换、循环切换、恢复会话） | `{ provider, modelId, previous?: { provider, modelId }, source }`，`source` 是 `set` / `cycle` / `restore` | 否 |
| `before_agent_start` | 每轮回复开始前（用户消息，或插件消息触发的一轮），只在主会话 | `{ prompt, kind }`：`kind` 为 `user` 时 `prompt` 是用户消息正文（最多 64K 字符），为 `custom` 时是空串 | 返回 `{ append }` 把文本追加到本轮 system prompt 末尾；多个插件按 id 顺序用空行拼接，合计最多 16K 字符。只能追加，不能拦下，所以不接受 `failClosed` |

要在派子代理之前检查或改写，拦截 `tool_call` 并写 `tools: ['subagent']`；要在消息发出前改写或吞掉，用 `input`。

`tools` 只对 `tool_call` / `tool_result` 有效，限定只对这些工具名触发。通知型的返回值被忽略，不阻塞会话。插件进程没在运行、且不是常驻时，通知直接丢掉，不会为此拉起进程。主会话的 `before_compact` 也一样：只等已经在运行的插件，不会为了等待去拉起非常驻插件。

通知按「插件 + 事件 + 会话」分开投递；子代理或 coworker 再按子会话身份（种类、子会话 id、名字）分开，所以一个会话的 `session_end` 不会盖掉另一个会话或子代理的。`context_usage` 和 `tool_result` 这类高频通知，同一条队列上如果上一条还在处理，后来的只保留最新一条。`session_start` / `session_end`、`agent_start` / `agent_end`、`before_compact` / `after_compact`，以及通知型的 `tool_call`、`input`，不合并，按到达顺序排队，每条队列最多 32 条，满了丢掉最旧的。

`context_usage` 与输入框旁的上下文占用同源：`buckets` 是 `system` / `instructions` / `skills` / `tools` / `conversation` / `compaction` / `reminders` 各自的 token 数（文件、工具结果都算在 `conversation` 里），`used` 是总占用，`estimated` 为 `true` 表示还没有模型实报用量可校准、全部是估算。`usage` 是最近一次带用量的回复的实报 `{ input, output, cacheRead, cacheWrite }`，可据此算缓存命中率；还没有回复时不带。同一轮里会发多次，按最后一次为准。

`parts` 是更细的拆分，形状与 magpie 的 prompt parts 相同：按 `system` / `tools` / `skills` / `memory` / `files` / `results` / `chat` 顺序，每类 `{ kind, tokens, items }`，空的类不出现。`items` 每项 `{ name, tag, n?, tokens }`，每类最多 24 项：

- `tools`：每个工具一项；同一 MCP server 的工具合成一项（`tag: 'mcp'`，`name` 为 `mcp__<server>`，`n` 为工具数）。
- `skills`：每个 skill 一项。`memory`：每个指令文件一项（`tag: 'project'`，`name` 为路径），待办提醒一项（`tag: 'reminder'`）。
- `files`：读文件工具读入的文件（`tag: 'read'`）、只读 shell 命令（`cat` / `head` / `sed -n` 等）读入的文件（`tag: 'shell'`）、图片（`tag: 'image'`）。
- `results`：其余工具输出，按工具名合并（`tag: 'result'`，`n` 为次数）。
- `chat`：按用户轮次，`name` 为轮次序号（`tag: 'turn'`），从旧到新；超出时最早的合成一项（`tag: 'turns'`）；压缩摘要排最前（`tag: 'compacted'`）。

其余类超出 24 项时，最小的合成一项（`tag: 'more'`）。`memory` 合计 = `instructions + reminders`，`files + results + chat` 合计 = `conversation + compaction`，其余类与同名 `buckets` 相等。`turns` 是当前上下文里用户发言的轮数。

多个插件拦截同一事件时按插件 id 顺序依次询问，后一个看到的是前一个改写后的数据；一旦有插件拦下或吞掉，后面的不再询问。每个插件限时 5 秒，一次拦截合计不超过 25 秒。处理函数抛错或超时时默认放行；设了 `failClosed: true` 的则拦下。合计时长用尽时，还没轮到的插件也按各自的 `failClosed` 处理。只有 Enso 自身出错（与任何插件无关）时才无条件放行。

同一插件的同一事件连续失败 3 次（报错或超时）后熔断：之后 30 秒内该事件不再询问它，直接放行，即使设了 `failClosed`。界面会提示「插件 X 的检查连续失败，已临时放行」，设置页的插件行显示放行到何时，日志里有记录。到期后下一次事件会试探询问：成功则恢复，失败则按 `failClosed` 处理并再熔断 30 秒。因前面的插件拖慢而没轮到的不计入失败次数。停用、卸载、更新插件会立即解除它的熔断并重新计数。

### 会话状态

`state` 是主会话连同它的子代理、coworker 汇总出的状态，优先级与侧栏圆点一致：

| `state` | 含义 |
| --- | --- |
| `error` | 主会话上一轮失败或 worker 退出；下一轮开始运行时清除。子会话失败不算 |
| `waiting` | 有等你回答的提问（`pendingAsks`）或等你审批的工具调用（`pendingApprovals`），含子会话的 |
| `running` | 主会话、某个子会话或子代理在运行，或会话正在启动 |
| `idle` | 以上都不是 |

`session_status` 只在 `state` 或两个挂起数变化时发，`previous` 是上一次通知时的 `state`（首次为 `idle`），`ctx.sessionId` 与 `data.sessionId` 都是主会话 id。它由 Enso 汇总后派发，不经过会话本身，所以不进会话的事件计划，订阅它也不会让会话多等；按到达顺序排队，不合并。和其他事件一样，Bot 会话不发。

### 回合结束

`session.onTurnEnd(listener)` 在主会话的一轮执行结束时回调 `listener({ sessionId })`，正常完成、失败、被中止各发一次，过程中的流式输出不发。适合常驻进程在 Agent 答完后立刻收尾，例如停掉聊天软件里的「正在输入」。不需要在清单里声明事件，也不需要在宿主发起的调用里，`activate` 里就能订阅。

```js
export function activate(enso) {
  // 返回值是取消订阅函数，不再需要时调用
  const off = enso.session.onTurnEnd(({ sessionId }) => stopTyping(sessionId));
}
```

- 权限：`session.read` 或 `session.readAll`。没有时订阅失败，原因写进插件日志，回调不会触发。
- 范围：有 `session.readAll` 时收所有项目的主会话；只有 `session.read` 时，只收与本插件被调用过（工具、命令、事件等发起会话）或成功注入过消息的会话同项目的主会话。常驻进程刚启动、还没碰过任何会话时收不到。子会话和 Bot 会话不发。
- 返回的函数取消这一次注册；全部取消后宿主不再推送。插件进程退出、插件被停用或卸载后订阅随之失效，进程重新拉起后需在 `activate` 里重新订阅。会话被删除后不再用它判定范围。
- 回调抛错或返回的 Promise 失败只写插件日志，不影响其他回调。

### 子代理与 coworker

Agent 用 `subagent` 工具派出的子代理和 coworker（下称子会话）也能用插件，边界如下：

- **工具**：子会话拿到主会话的全部插件工具，不按 agent 类型另设白名单。例外：只读类型（`tools: readonly`，如 scout）不拿——插件工具可能有副作用，Plan 模式靠只读子代理保证不写；内置 Enso 系统代理（锁定档）不拿任何插件能力。启用、停用插件只对之后新开的主会话生效，子会话沿用所属主会话拿到的那一份。
- **审批**：走子会话自己的审批，审批条出现在子会话里，档位继承自主会话。在主会话里选的「本会话内允许」不带到子会话，反之亦然，与 MCP 工具一致。
- **来源**：子会话里的工具调用和事件，`ctx.sessionId` 与 `ctx.projectRoot` 仍是所属主会话的（`session.inject` 缺省也发到主会话），`ctx.agent` 标明来源：`{ kind: 'subagent' | 'coworker', sessionId, name, agentType? }`。`sessionId` 是子会话 id（形如 `<主会话 id>::…`），`name` 是子代理实例名或 coworker 名，`agentType` 是类型名（未指定类型的 coworker 没有）。主会话的 `ctx.agent` 是 `null`。
- **只拦 `tool_call`**：主会话里能拦下的工具调用，派给子会话同样拦得下：`mode: 'intercept'` 的 `tool_call` 订阅会收到子会话的工具调用（`ctx.agent` 标明来源），可以拦下或改写参数，`tools` 过滤、合并顺序与主会话相同。`tool_result` 与 `input` 在子会话里不拦截，只投给 `mode: 'observe'` 的订阅。子会话的拦截单独计时：每个插件限时 2 秒，一次拦截合计不超过 5 秒，从这次拦截自己开始时算起，不占主会话或其他子会话的时间。超时与报错按 `failClosed` 处理，与主会话一致；熔断规则也一致，但与主会话分开计数：子会话里连续失败只放行子会话，主会话照常询问（设置页显示为「tool_call（子代理与 coworker）」）。插件自己把事件串行处理时，子会话的一次检查最多给别的会话增加约 5 秒延迟；超时时 `ctx.signal` 会 abort，请据此尽早结束。
- **其余事件只通知**：`before_compact` 在子会话里只是通知，不等插件处理完就压缩。子会话也不接受注入。
- **生命周期**：子会话建好后发 `session_start`（`reason` 是 `startup` 或 `resume`）；被解雇时发 `session_end`（`reason: 'dismissed'`），所属主会话被释放时发 `session_end`（`reason: 'parent_ended'`）。Agent 进程退出时不再发事件。
- **收敛**：子会话被中断、解雇、随主会话释放，或 Agent 进程退出时，它正在进行的插件工具调用被取消，插件侧的 `ctx.signal` abort；之后这个子会话不再发事件，晚到的工具结果和检查结果被丢弃。被中断、解雇或随主会话释放时，还在等检查的工具调用按拦下结束，不会在之后执行。插件侧的这次检查仍按上面的时限结束。
- **限制**：与主会话相同。工具结果 1MB、按声明超时（最长 600 秒）；每次调用各自计时，不同子会话之间不互相等待，并发量受同时在岗的子会话数上限约束，不另设上限。

### 向会话发消息

`session.inject({ text, images?, sessionId?, deliverAs?, triggerTurn? })` 把一条消息加进会话。需要 `agent.inject`。消息在会话里单独成行，标明「来自插件 <名称>」和插件 id，样式与用户消息、模型回复都不同。模型侧按用户角色收到原文，不带来源标记；需要模型知道来源时请在文本里自己写明。

- `sessionId` 缺省取当前调用所属的会话，都没有则返回 `NO_SESSION`。会话必须正在运行，否则返回 `INJECT_FAILED`。
- 常驻进程在宿主调用之外（如自己的轮询循环）也能用 `session.inject` / `session.abort`，但必须指明 `sessionId`，并且同样要用户打开下面的跨会话开关。
- 发到发起调用以外的会话（包括定时任务、常驻进程里没有当前会话时指定的 `sessionId`）要用户在设置页该插件下打开「允许向任意运行中的会话发送消息」（命令行 `enso-server plugin inject-anywhere <id>`），否则返回 `PERMISSION_DENIED`。新装的插件默认关闭。关闭开关只影响之后的发送，已经投递、排队等下一轮的消息不会撤回。
- 每个插件 10 秒内最多 5 条，超过返回 `RATE_LIMITED`。只有参数不合法和目标未授权被拒的不计入；目标会话没在运行（`INJECT_FAILED`）也计入。
- `deliverAs`：`nextTurn`（缺省，并入下一轮）、`steer`（插入正在进行的回复）、`followUp`（当前回复结束后排队）。
- `triggerTurn: true` 时会话空闲也会立即开始一轮。
- 文本不超过 32K 字符。
- `images` 是 `[{ data, mimeType }]`，`data` 为 base64，`mimeType` 只能是 `image/png`、`image/jpeg`、`image/webp`、`image/gif`；最多 4 张，每张 base64 不超过 7M 字符。图片随文字一起交给模型，不合法返回 `INVALID_ARGS`。

`session.abort(sessionId?)` 中止会话正在进行的一轮，权限与目标会话规则同 `session.inject`（不计入频率限制）。会话没在运行返回 `ABORT_FAILED`。

### 状态项

`enso.ui.status.update(id, { text?, tooltip?, tone?, visible? })` 改清单 `statusItems` 里声明过的项，没声明的 id 会被拒绝。`tone` 是 `neutral`（缺省）、`accent`、`success`、`warning`、`danger`；`visible: false` 隐藏。不需要权限，也不需要在宿主发起的调用里，常驻进程和定时任务都能直接更新；和侧栏事件共用每秒 20 次的上限。更新只保存在内存里，应用重启后回到清单里的值。

### 产出文件

`artifacts.write({ name, text })` 或 `artifacts.write({ name, base64, mime? })` 保存一份文件，返回 `{ id, pluginId, name, mime, size, createdAt }`。不需要权限，但只能在宿主发起的调用里用。`name` 是不带路径的文件名（最长 200 字符，不能含 `/`、`\`）。单个不超过 50MB，每个插件最多保留 200 个，超出时删掉最旧的；卸载插件时全部删除。

在工具调用里写的产出会自动挂到这次工具结果上：模型看到的文本末尾多一行产出列表，工具卡片下方可以预览（文本、图片）和另存。设置页的插件详情里可以查看和删除全部产出。

### 常驻与定时任务

`resident: true` 的插件启用后就拉起进程并一直运行，意外退出 5 秒后重启；同时最多 5 个常驻插件，超出的不启动并在设置页显示原因。清单 `schedules` 声明的任务按间隔执行，同一个任务上一次没跑完时跳过这一次；设置页显示最近一次的运行时间和错误。停用插件后常驻进程退出、定时任务停止。崩溃停用规则同样适用。

### 插件间调用

被调方在清单 `exports` 里声明方法，并用 `exports.handle(name, handler)` 注册，`handler(args, ctx)` 的 `ctx.caller` 是调用方插件 id。调用方申请 `plugin.call`，把对方 id 列进 `interop.call`，再用 `plugins.call(pluginId, name, args)`。对方必须已启用；调用最多嵌套 3 层，超出返回 `CALL_DEPTH`。

### 网络

`net.fetch` 只接受 `http` 和 `https`，主机名必须在 `net.domains` 里，不允许 URL 内嵌用户名密码。`init` 支持 `method`、`headers`、`body`、`responseType`。返回 `{ status, headers, body }`，`body` 是字符串；`responseType: 'base64'` 时为响应原始字节的 base64，用于下载图片等二进制内容。响应不超过 5MB，最多跟随 5 次重定向，重定向到未授权的域名会被拒绝。

### 文件

读写都限制在清单声明的范围内，单文件不超过 5MB。符号链接解析后必须仍在项目目录内，不能借链接逃出项目，也不能写入符号链接。会话没有本机项目目录（比如临时会话）时读写都会失败。

### 宿主 MCP

插件可以调用用户在 Enso 里已配置并启用的 MCP 服务，不需要自己保存服务地址或凭据；凭据留在 Enso 里，插件只拿到工具返回的文本。

- `mcp.tools()` 返回 `[{ server, name, description }]`，只包含 `mcp.tools` 里声明过的工具名。连不上的服务会被跳过。
- `mcp.call(server, tool, args)` 返回 `{ content, isError }`，`content` 是工具返回的全部文本拼在一起。`tool` 必须在 `mcp.tools` 里，`args` 是不超过 64KB 的对象。
- 都只能在宿主发起的调用里用（工具、命令、补全、渲染方法）。所在调用超时或被取消时，挂起的 MCP 请求一起中止。单次请求最长 120 秒，同时受 MCP 服务自身的调用超时限制。
- 不走工具审批：用户在安装时已经同意了可调用的工具名。

### 配置项

用户填写的值保存在 Enso 的私有目录（文件权限 600），不进 `settings.json`，也不会发给界面：密钥字段在设置页和命令行里只显示「已设置 / 未设置」。卸载插件时一并删除。值修改后，下一次 `config.get()` 就能读到。

### 草稿

`main.mjs` 里只能在用户操作触发的调用里使用：点了渲染模块里的按钮、选了补全、或在侧栏页面里发起的调用。这类调用自带 30 秒的手势，超时后拒绝。Agent 工具里没有手势，不能改草稿。耗时可能超过 30 秒的操作，让后端只返回文本，由渲染模块用自己的 `enso.composer` 写回（见 `ui.js`）。

- `readDraft()` 返回 `{ text, hasReferences, generation, rev }`。`text` 只含纯文本，文件和会话引用会被跳过。
- `insertText({ text })` 把文字插到光标处，返回新的 `{ rev }`。
- `replaceDraft({ text, expect })` 整体替换。`expect` 传上次读到的 `{ generation, rev }`，对不上就返回 `DRAFT_CHANGED`，避免覆盖用户刚打的字。草稿里有文件或会话引用时返回 `DRAFT_HAS_REFERENCES`。

写入的文字按字面量处理，开头的 `/` 不会变成命令。单次不超过 32KB。输入法正在组字或输入框被锁定时返回 `DRAFT_BUSY`。请求只发回发起操作的那个窗口，不会写到别的窗口。

### 补全

`candidates(query, ctx)` 返回 `[{ id, label, detail? }]`。Enso 最多取 50 条，`label` 截到 64 字符，`detail` 截到 120 字符，缺 `id` 或 `label` 的条目会被丢弃。用户选中后 `pick(item, ctx)` 返回要插入的字符串，或 `{ text }`，超过 32KB 视为无效。输入框里输入 `#` 后约 120ms 触发一次查询。

### 调用频率

界面发起的调用（命令、补全、渲染模块、侧栏页面）每个插件每秒最多 10 次，超过返回 `RATE_LIMITED`。连续失败 5 次后熔断 30 秒，期间返回 `CIRCUIT_OPEN`。

## `ui.js`

渲染模块在主界面里运行，和 Enso 自己的界面同权，能操作页面上的一切。这和 `main.mjs` 不同，后者在独立进程里。所以渲染模块只适合你完全信任的插件。

带 `renderer` 的插件在设置页显示「受信任界面」，安装、更新和详情里写明界面代码不受权限清单约束。侧栏页面（`views`）跑在沙箱 iframe 里，不算受信任界面；只需要独立面板时优先用它。

`ui.js` 不是按文件 URL 加载的：宿主把源码放进 blob，再用 `import()` 执行。blob 没有插件目录作为基址，`import './util.js'` 这类相对模块解析不到，也不会去读插件包里的其他文件。入口必须是单文件。用 esbuild 打包：

```bash
esbuild src/ui.tsx --bundle --format=esm --platform=browser --outfile=ui.js
```

导出 `onLoad(enso)`：

```js
export function onLoad(enso) {
  const { React } = enso;
  enso.slots.register({
    slot: 'composer.right',
    component: () =>
      React.createElement('button', {
        onClick: () => enso.dispatch('plugin.call', { method: 'stamp', args: {} }),
      }, '时间'),
  });
}
```

`enso.React` 是完整的 React，可以用 hooks。`enso.slots.register` 返回取消函数，`onLoad` 的返回值如果是函数，卸载时也会被调用。

`enso.dispatch('plugin.call', { method, args })` 调用本插件 `main.mjs` 里 `enso.renderer.handle` 注册的方法。参数和返回值各不超过 1MB，默认 2 秒超时，清单 `contributes.methods` 里声明过的方法按声明的超时（最长 120 秒）。

申请了 `composer.draft` 的插件还有 `enso.composer`：`readDraft()`、`insertText({ text })`、`replaceDraft({ text, expect? })`，返回值和失败的错误码与 `main.mjs` 里的同名接口一致。它直接作用于当前窗口当前会话的输入框，不受 30 秒手势限制（渲染模块本来就和界面同权），但仍然受内容指纹、引用和输入法组字检查的约束。没有会话时报 `NO_SESSION`。

样式不要用 Tailwind 类名，插件的类不会被编译进去。用 CSS 变量跟随主题，例如 `var(--border)`、`var(--muted)`、`var(--muted-foreground)`、`var(--primary)`。

### 挂点

| `slot` | 额外字段 | 组件收到的 props | 状态 |
| --- | --- | --- | --- |
| `message.action` | `position: 'left' \| 'right'` | `{ position, text, messageIndex, sessionId }` | 可用。位于回复正文下方的操作条，`left` 在复制按钮之前，`right` 在复制按钮之后。`messageIndex` 是这条消息在会话里的下标，`sessionId` 是当前展示的会话 |
| `tool.card` | `toolName` | `{ toolName, output, state }` | 可用。`output` 是工具结果文本，可能为 `null` |
| `block` | `language` | `{ language, source }` | 可用 |
| `composer.left` / `composer.right` | 无 | `{ position, sessionId, draft, busy, pluginPresetId }` | 可用。`draft` 是当前草稿的纯文本，`busy` 表示输入框被锁定。`pluginPresetId` 是当前会话生效的插件预设 id。直接选插件预设时是它本身。选自建预设且其 `pluginPresetId` 是合法插件预设 id 时是叠加的那个。否则为 `null`。侧栏等独立输入框里 `sessionId` 为 `null` |
| `thinking.body` | 无 | `{ text, streaming, itemKey }` | 可用。接管展开后的思考正文；多个插件只渲染先注册的那个，组件抛错时回退显示原文 |
| `message.leaf` | 无 | `{ source, final, messageIndex, sessionId, Markdown }` | 可用。只在回复正文的文字叶子后追加，原文仍由宿主整体渲染。叶子是段落、标题、表格单元格，以及不包含段落的紧凑列表项；代码块、公式、分隔线和 HTML 不追加。`source` 是该叶子的行内 Markdown（不含 `#`、列表标记、表格竖线和引用标记），`final` 表示这个叶子是否已经写完，`messageIndex` / `sessionId` 与 `message.action` 相同。`Markdown` 是宿主的 Markdown 组件，用来渲染译文，且不会再次触发本挂点。多个插件只渲染先注册的那个；组件返回 null 或抛错时不追加内容，原文不受影响 |

其它 `slot` 注册时直接报错。

`tool.card` 只在该插件自己的工具结果上显示。`block` 对应代码块语言标记 `` ```<pluginId>:<language> ``，例如 `enso.example.wordstats` 插件注册 `language: 'bars'` 后，`` ```enso.example.wordstats:bars `` 会交给它渲染，`source` 是代码块内容。语言标记不区分大小写。

## 侧栏页面

`views` 里声明的 HTML 跑在 `sandbox="allow-scripts"` 的 iframe 里，和主界面不同源，拿不到主界面的任何接口，也不能加载外部资源。承载它的外层框架不能再加 sandbox：PWA 完整模式靠 Service Worker 取界面文件，没有 `allow-same-origin` 的沙箱 iframe 不会走 Service Worker，壳页面会是空的。页面里用相对路径引用的插件内文件——`<script src>`、`<link rel="stylesheet" href>`、`<img src>`——会在打开时内联进页面（脚本和样式转成内联，图片转成 `data:`），路径相对页面所在目录；绝对路径、带协议的 URL 和超出插件目录的引用保持原样，不会加载。脚本里的 `import` 不会被解析，需要先打包成单文件。

页面里用 `window.enso`：

- `enso.theme`：`'light'` 或 `'dark'`，当前主题。`<html>` 上的 `data-theme` 会随宿主主题一起变。
- `enso.onTheme(listener)`：主题变化时调用 `listener(theme)`，返回取消订阅的函数。打开页面时不会立刻回调，当前值读 `enso.theme`。
- `enso.on(name, listener)`：主进程 `enso.ui.view.emit` 的同名事件到达时调用 `listener(data)`，返回取消订阅的函数。只发给本插件自己的侧栏页面。
- `enso.call(method, args)`：调用本插件 `renderer.handle` 注册的方法，返回 Promise。
- `enso.storage.get(key)` / `set(key, value)` / `remove(key)`：页面状态，关闭重开后仍在。值按字符串保存。页面里的 `localStorage` 是另一份包装，方法名是标准的 `getItem` / `setItem` / `removeItem` / `clear`，读写同一份数据。读取是同步的（打开页面时的快照加本页写入），写入异步保存。每个插件合计不超过 1MB，卸载时删除。

iframe 只有 `allow-scripts`，没有 `allow-modals`，`alert`、`confirm`、`prompt` 都不可用。

```html
<button id="add">添加</button>
<script>
  document.getElementById('add').onclick = async () => {
    const notes = await window.enso.call('list');
  };
</script>
```

从侧栏页面发起的调用算用户操作，所以在这里可以改草稿。页面不能直接发系统通知，需要的话在 `main.mjs` 的处理函数里调 `enso.ui.notify`。

## 文件查看器

`fileViewers` 的页面和侧栏页面跑在同一种沙箱 iframe 里，`window.enso` 的能力都一样，另外多一个 `enso.file`（侧栏页面里是 `null`）：

- `enso.file.rel` / `enso.file.text`：当前文件的相对路径和编辑区里的内容（含未保存的修改）。只支持文本文件，超出编辑器上限的文件不会交给查看器。
- `enso.file.onChange(listener)`：内容在别处变了（切回编辑器改过、磁盘重新加载）时调用 `listener({ rel, text })`，返回取消订阅的函数。查看器自己 `update` 的内容不会回调。
- `enso.file.update(text)`：把新内容交回编辑区，标签变成未保存，由用户保存。查看器拿不到磁盘路径，也不能直接写文件。

一个文件被多个查看器匹配时，后缀更长的排前面；文件名正好等于后缀（如 `.csv`）不算匹配。插件停用后，打开中的文件回到编辑器。

## skill 与 MCP

`skills` 列出的目录会在新建会话时并入 skill 搜索路径，排在内置 skill 和 Claude 插件之后。Bot 会话不并入。被某个 `presets` 点名的 skill 或 MCP 不再进入每个会话，只在选中那个预设时并入；没被任何预设点名的仍随插件启用进入每个新会话。

`mcpServers` 在会话启动时拉起，生命周期和审批沿用 Enso 现有的 MCP 实现。

选中插件预设时，用它的指令文件代替当前启用的全局指令；没写 `instruction` 就沿用当前启用的全局指令。角色描述、真尾、boost 和推脱补发按文件内容下发，缺的字段沿用默认。用户自己启用的 skill 和 MCP 仍然保留。插件停用或预设被删掉之后，已经选中的会话在启动时会失败，需要改回别的预设。

## 子代理类型

`contributes.agentTypes` 给子代理提供固定角色，和 Claude 格式插件的 `agents/*.md` 等价。不需要额外权限，也不需要 `main`。

| 字段 | 要求 |
| --- | --- |
| `name` | 给模型看的类型名。小写 slug `^[a-z][a-z0-9_-]*$`，可带一个命名空间前缀如 `notes:reviewer`，总长不超过 64。不能是内置类型名（`scout`、`worker` 等）或保留名（`enso`，`agent:` / `builtin:` / `custom:` / `builtin-agent:` / `bot:` 开头）。同插件内不能重复 |
| `description` | 必填，最长 1024 字符，模型据此选择类型 |
| `systemPrompt` | 必填，插件目录里的 Markdown 文件，作为子代理的系统提示。安装时必须存在；运行时读不出（缺失、为空或超过 256KB）的类型会被跳过并写进插件日志 |
| `tools` | `all`（缺省）或 `readonly`，按声明原样生效，不从工具名推断 |
| `skills` | 可选，只能引用本插件 `skills` 里已声明的目录，派生这个类型的子代理时附加。不受预设范围影响 |
| `modelMode` | 可选，`follow`（缺省）或 `agent_pick`。`agent_pick` 时主 agent 派生可传 `model` / `thinking`；用户没配置可选子代理模型时退回跟随会话 |

插件启用后立即出现在子代理类型列表里，停用或卸载后立即消失；Bot 会话不下发 Enso 插件的子代理类型。被某个 `presets` 的 `agentTypes` 点名的类型只在那个预设生效时（直接选中，或被自建预设叠加）下发给会话；设置页列表和 @ 派发仍列出全部类型。

同名时的优先级（名字去首尾空白、忽略大小写比较）：用户自定义类型 > Claude 插件的子代理 > Enso 插件。Enso 插件之间按插件 id 排序，排在前面的先占名字。被挤掉的类型写进对应插件的日志（每个类型只记一次）。

## 限制汇总

| 项 | 限制 |
| --- | --- |
| 清单 | 256KB |
| 插件包 | 5000 个文件、合计 200MB（目录、zip、链接安装一致） |
| 文件读写 | 单文件 5MB |
| 网络响应 | 5MB，最多 5 次重定向 |
| 工具结果 | 1MB；按声明超时（1–600 秒），缺省 60 秒 |
| 工具进度 | 每 200ms 一次，单条 16K 字符 |
| 产出文件 | 单个 50MB，每插件 200 个 |
| 侧栏页面状态 | 每插件 1MB |
| 会话拦截 | 每插件 5 秒，合计 25 秒；`before_compact` 10 秒；子代理与 coworker 只拦 `tool_call`，每插件 2 秒、合计 5 秒（单独计时），其余事件只通知、不等待 |
| 注入消息 | 32K 字符；每插件 10 秒 5 条 |
| 拦截熔断 | 同事件连续失败 3 次放行 30 秒；子代理与 coworker 单独计数 |
| 剪贴板 | 1MB |
| 动态注册 | 工具 50 个，命令 20 个 |
| 定时任务 | 最多 10 个，间隔 60–86400 秒，单次缺省 60 秒 |
| 常驻插件 | 同时 5 个，意外退出 5 秒后重启 |
| 插件间调用 | 嵌套 3 层 |
| 透传环境变量 | 20 个 |
| 界面调用 | 参数与返回值各 1MB；命令 60 秒，声明过的渲染方法按声明（最长 120 秒），其余 2 秒 |
| 宿主 MCP | 参数 64KB；单次最长 120 秒 |
| 配置项 | 最多 20 项，每个值 4096 字符 |
| 子代理类型 | 每插件 20 个，类型名 64 字符，提示词文件 256KB |
| 草稿写入 | 32KB |
| 系统通知 | 标题 200 字符，正文 1000 字符 |
| 补全 | 50 条，label 64 字符，detail 120 字符，插入文本 32KB |
| 调用频率 | 每插件每秒 10 次；连续失败 5 次熔断 30 秒 |
| 事件通知 | 同一插件、同一事件、同一会话（子代理另计）同时最多 1 次在途；`context_usage` 与 `tool_result` 只保留最新一条，其余通知按顺序最多排 32 条；`tool_result` 通知正文 64K 字符 |
| 插件日志 | 1MB 轮转；每插件每秒 100 行，超出记一条已丢弃行数 |
| 进程 | 启动限时 10 秒；非常驻空闲 5 分钟退出；10 分钟内崩溃 3 次自动停用；退出前 `deactivate` 最多 3 秒 |

## 错误码

宿主接口失败时抛出的错误带 `code`：

| code | 含义 |
| --- | --- |
| `PLUGIN_DISABLED` | 插件未启用 |
| `PLUGIN_INIT_FAILED` | `activate` 抛错或没有导出 |
| `PLUGIN_EXITED` | 插件进程已退出 |
| `NOT_FOUND` | 没有注册这个工具、命令或方法，或文件不存在 |
| `NOT_DECLARED` | 清单没有声明这项能力 |
| `PERMISSION_DENIED` | 没有权限、域名未授权，或路径超出范围 |
| `NO_INVOCATION` | 在宿主发起的调用之外使用了宿主接口 |
| `NO_SESSION` | 调用不属于任何会话 |
| `NO_PROJECT` | 当前会话没有本机项目目录 |
| `NO_COMPOSER` | 该会话的输入框不在发起操作的窗口里 |
| `GESTURE_REQUIRED` | 没有用户操作，或距操作已超过 30 秒 |
| `DRAFT_CHANGED` | 草稿在读取之后被改过 |
| `DRAFT_HAS_REFERENCES` | 草稿里有文件或会话引用，不能整体替换 |
| `DRAFT_BUSY` | 正在输入法组字或输入框已锁定 |
| `INVALID_ARGS` | 参数不合法 |
| `MCP_ERROR` | 宿主 MCP 连接或调用失败，`message` 是原因 |
| `TOO_LARGE` | 超过大小限制 |
| `TOO_MANY_REDIRECTS` | 重定向超过 5 次 |
| `BAD_RESULT` | 工具返回值不是合法结果 |
| `TIMEOUT` | 调用超时 |
| `ABORTED` | 调用被取消 |
| `RATE_LIMITED` | 调用或注入过于频繁 |
| `CIRCUIT_OPEN` | 连续失败，30 秒内拒绝 |
| `QUOTA` | 动态工具或命令已达清单上限 |
| `CALL_DEPTH` | 插件间调用嵌套超过 3 层 |
| `INJECT_FAILED` | 会话不在运行或未接受注入 |
| `UNSUPPORTED` | 当前环境不支持（服务端的系统通知、剪贴板和外链，Agent 进程不可用时的 MCP 调用）。用 `host.capabilities()` 提前判断 |
