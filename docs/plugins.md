# 编写 Enso 插件

插件是一个带 `enso-plugin.json` 的目录。安装后 Enso 把它复制到自己的数据目录里运行，不引用原路径。

可以参考的完整例子在 [`examples/plugins/`](../examples/plugins/README.md)：`word-stats`（工具、结果卡片、代码块、skill）、`snippets`（补全、按钮、改草稿）、`notes`（侧栏页面、私有数据）、`github-repo`（网络请求、系统通知）、`prompt-enhance`（移植自 dsh-bce：调用宿主 MCP、长耗时方法、配置项、渲染模块直接改草稿）。

## 安装与管理

- 桌面：设置 → 插件 → Enso plugins → 安装目录。
- 桌面也可以粘贴链接安装：http(s) 的 zip，或 GitHub 仓库（`https://github.com/owner/repo`；仓库里的子目录用 `.../tree/分支/子目录`）。本机下载 zip 后复制进数据目录，不保留原地址。私有仓库不支持。
- 服务端：`enso-server plugin install <目录、zip 或 http(s) 链接>`，确认后 `enso-server plugin enable <id>`。
- 新装的插件默认停用，需要手动启用。
- 同 id 再装一次按更新处理。权限没有变大就直接换新版；权限变大则旧版继续运行，需要 `enso-server plugin approve <id>`（或设置页同意）才切到新版，`reject` 则留在旧版。
- 10 分钟内非预期崩溃 3 次，插件会被自动停用，状态变成 `crashed`，重新启用即可。
- 有配置项的插件：设置页插件行的齿轮按钮，或 `enso-server plugin config <id>`（查看）/ `enso-server plugin config <id> key=value`（设置；`key=` 留空会在终端里提示输入，不进 shell 历史；`--unset key` 清除）。

## 清单 `enso-plugin.json`

不超过 256KB，必须是 JSON 对象，`schemaVersion` 固定为 `1`。未知字段会被忽略并给出警告。

```json
{
  "schemaVersion": 1,
  "id": "enso.example.notes",
  "name": "Notes",
  "version": "1.0.0",
  "description": "侧栏便签",
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
| `engines.enso` | 可选，只支持 `>=x.y.z`；宿主机版本不够则拒绝安装 |
| `main` | 可选，插件目录内的相对路径。声明了工具、命令、补全来源、方法或配置项时必填 |
| `renderer` | 可选，渲染模块的相对路径 |
| `permissions` | 见下表，重复项自动去重 |
| `fs.read` / `fs.write` | 相对项目根的目录范围，`.` 表示整个项目。填了就必须申请对应权限 |
| `net.domains` | 主机名，如 `api.github.com`，不含协议和路径。填了就必须申请 `net.fetch` |
| `mcp.tools` | 允许调用的宿主 MCP 工具名（字母、数字、`_ . -`，最长 64）。填了就必须申请 `mcp.call`，申请了 `mcp.call` 也必须填 |

路径一律是插件目录内的相对路径：不能是绝对路径、不能含 `..`、不能含反斜杠。

### 权限

声明了某项贡献就必须申请对应权限，否则拒绝安装。

| 权限 | 何时需要 | 允许做什么 |
| --- | --- | --- |
| `agent.tool` | 有 `agentTools` | 注册 Agent 工具 |
| `ui.slot` | 有 `renderer` 或 `triggers` | 渲染模块、补全来源 |
| `ui.view` | 有 `views` | 侧栏页面 |
| `ui.notify` | 要发系统通知 | `enso.ui.notify` |
| `composer.draft` | 要读写输入框 | `enso.composer.*` |
| `fs.read` / `fs.write` | 声明了对应范围 | 读写当前会话的项目文件 |
| `net.fetch` | 声明了域名 | 访问这些域名 |
| `session.read` | 要读会话消息 | 见下方「当前未接通」 |
| `mcp.server` | 有 `mcpServers` | 随会话拉起 MCP 服务 |
| `mcp.call` | 有 `mcp.tools` | 调用用户已配置的 MCP 服务里、清单列出的工具 |

安装时展示的是这些权限，但插件的 `main` 本身是完整的 Node 进程，权限只约束它能向 Enso 申请的能力，不约束它自己的代码。只安装你信任的插件。

### 贡献

- `agentTools`：`{ name, description, parameters }`。`name` 匹配 `^[a-z][a-z0-9_]*$`，不能含 `__`。`description` 最长 1024 字符。`parameters` 必须是 `type` 为 `object` 的 JSON Schema。模型看到的工具名是 `plugin_<id>__<name>`，其中 id 的 `.` 换成 `-`，总长不超过 64 字符。
- `commands`：`{ id, title }`。`id` 匹配 `^[a-z][a-z0-9-]{0,31}$`。
- `views`：`{ id, title, entry }`。`title` 最长 40 字符，`entry` 必须是 `.html`。
- `triggers`：`{ symbol, name }`。`symbol` 只能是 `#`，`@` 和 `/` 归 Enso 自己用。
- `skills`：skill 目录的相对路径，随插件下发给新会话。
- `mcpServers`：`{ name, command, args, env }`。服务名会加 `plugin-<id>-` 前缀。`command`、`args`、`env` 里的 `${ENSO_PLUGIN_ROOT}` 会展开成插件安装目录，`env` 只能写字面量。
- `presets`：`{ id, name, skills, mcpServers, instruction?, systemPrompt?, systemPromptTail?, boostPrompt?, refusalRetry?, refusalRetryPrompt? }`，最多 20 个。`skills` 和 `mcpServers` 只能引用本插件已经声明的 skill 目录和 MCP 服务名。指令和角色、真尾、boost、推脱补发都是插件目录里的 Markdown 文件。启用后出现在预设列表里，只读，不能在设置里改。会话 id 是 `plugin:<插件 id>:<预设 id>`。
- `methods`：`{ name, timeoutMs }`，给 `renderer.handle` 注册的方法声明更长的超时，1000 到 120000 毫秒的整数。没声明的方法 2 秒超时。
- `configuration`：`{ key, title, description?, secret? }`，最多 20 项。`key` 匹配 `^[A-Za-z][A-Za-z0-9_]{0,31}$`，`title` 最长 60 字符。用户在设置页或命令行里填写，插件用 `enso.config.get()` 读取。

同一类贡献里的 `id` 或 `name` 不能重复。

## `main.mjs`

导出 `activate(enso)`，Enso 在插件进程启动时调用它。进程空闲 5 分钟后退出，下次调用时重新启动，所以不要依赖常驻内存的状态，要持久化就写 `enso.dataDir`。

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
| `tools.register(name, handler)` | `handler(args, ctx)` 返回字符串，或 `{ content, details? }`。其它返回值会被序列化成 JSON 字符串 |
| `commands.register(id, handler)` | `handler(ctx)` |
| `triggers.register(name, handlers)` | `handlers.candidates(query, ctx)` 与 `handlers.pick(item, ctx)` |
| `renderer.handle(method, handler)` | 供渲染模块和侧栏页面调用，`handler(args, ctx)` |
| `fs.readText(path)` / `fs.writeText(path, text)` | 路径相对当前会话的项目根 |
| `net.fetch(url, init?)` | 见下 |
| `ui.notify(title, body?)` | 系统通知 |
| `composer.readDraft()` / `insertText(input)` / `replaceDraft(input)` | 见下 |
| `session.messages()` | 见「当前未接通」 |
| `config.get()` | 本插件的配置值 `{ [key]: string }`，未设置的键不出现。不需要权限，`activate` 里也能调 |
| `mcp.tools()` / `mcp.call(server, tool, args?)` | 见下 |

每次 `register` 都返回一个取消函数。`ctx` 含 `sessionId`（可能为 `null`）、`projectRoot`（当前会话的本机项目绝对路径，没有本机项目时为 `null`）、`invocationId` 和 `signal`（调用被取消或超时时 abort）。

插件进程不继承 Enso 的环境变量。上面这些宿主接口每次调用都回到主进程校验，校验失败抛带 `code` 的错误，见文末错误码。

### 工具返回值

`content` 是给模型看的文本，`details` 是任意 JSON，只给界面用（比如结果卡片）。整个结果不超过 1MB，单次调用限时 60 秒。工具调用走和 MCP 工具相同的审批，用户的审批档位同样生效。

### 网络

`net.fetch` 只接受 `http` 和 `https`，主机名必须在 `net.domains` 里，不允许 URL 内嵌用户名密码。`init` 支持 `method`、`headers`、`body`。返回 `{ status, headers, body }`，`body` 是字符串。响应不超过 5MB，最多跟随 5 次重定向，重定向到未授权的域名会被拒绝。

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

`enso.dispatch('plugin.call', { method, args })` 调用本插件 `main.mjs` 里 `enso.renderer.handle` 注册的方法。参数和返回值各不超过 64KB，默认 2 秒超时，清单 `contributes.methods` 里声明过的方法按声明的超时（最长 120 秒）。

申请了 `composer.draft` 的插件还有 `enso.composer`：`readDraft()`、`insertText({ text })`、`replaceDraft({ text, expect? })`，返回值和失败的错误码与 `main.mjs` 里的同名接口一致。它直接作用于当前窗口当前会话的输入框，不受 30 秒手势限制（渲染模块本来就和界面同权），但仍然受内容指纹、引用和输入法组字检查的约束。没有会话时报 `NO_SESSION`。

样式不要用 Tailwind 类名，插件的类不会被编译进去。用 CSS 变量跟随主题，例如 `var(--border)`、`var(--muted)`、`var(--muted-foreground)`、`var(--primary)`。

### 挂点

| `slot` | 额外字段 | 组件收到的 props | 状态 |
| --- | --- | --- | --- |
| `message.action` | `position: 'left' \| 'right'` | `{ position, text }` | 只渲染 `right`，位于消息文本右侧 |
| `tool.card` | `toolName` | `{ toolName, output, state }` | 可用。`output` 是工具结果文本，可能为 `null` |
| `block` | `language` | `{ language, source }` | 可用 |
| `composer.left` / `composer.right` | 无 | `{ position, sessionId, draft, busy }` | 可用。`draft` 是当前草稿的纯文本，`busy` 表示输入框被锁定；侧栏等独立输入框里 `sessionId` 为 `null` |
| `composer.activity` / `composer.dock` | 无 | — | 已保留，界面还没有挂载，注册了也不会显示 |

`tool.card` 只在该插件自己的工具结果上显示。`block` 对应代码块语言标记 `` ```<pluginId>:<language> ``，例如 `enso.example.wordstats` 插件注册 `language: 'bars'` 后，`` ```enso.example.wordstats:bars `` 会交给它渲染，`source` 是代码块内容。语言标记不区分大小写。

## 侧栏页面

`views` 里声明的 HTML 跑在 `sandbox="allow-scripts"` 的 iframe 里，和主界面不同源，拿不到主界面的任何接口，也不能加载外部资源。页面必须自包含：脚本和样式内联，图片只用 `data:` 或 `blob:`。

页面里用 `window.enso`：

- `enso.theme`：`'light'` 或 `'dark'`，打开页面时确定，不会随主题切换更新。`<html>` 上同时有 `data-theme`。
- `enso.call(method, args)`：调用本插件 `renderer.handle` 注册的方法，返回 Promise。

```html
<button id="add">添加</button>
<script>
  document.getElementById('add').onclick = async () => {
    const notes = await window.enso.call('list');
  };
</script>
```

从侧栏页面发起的调用算用户操作，所以在这里可以改草稿。页面不能直接发系统通知，需要的话在 `main.mjs` 的处理函数里调 `enso.ui.notify`。

## skill 与 MCP

`skills` 列出的目录会在新建会话时并入 skill 搜索路径，排在内置 skill 和 Claude 插件之后。Bot 会话不并入。被某个 `presets` 点名的 skill 或 MCP 不再进入每个会话，只在选中那个预设时并入；没被任何预设点名的仍随插件启用进入每个新会话。

`mcpServers` 在会话启动时拉起，生命周期和审批沿用 Enso 现有的 MCP 实现。

选中插件预设时，用它的指令文件代替当前启用的全局指令；没写 `instruction` 就不注入指令。角色描述、真尾、boost 和推脱补发按文件内容下发，缺的字段沿用默认。用户自己启用的 skill 和 MCP 仍然保留。插件停用或预设被删掉之后，已经选中的会话在启动时会失败，需要改回别的预设。

## 当前未接通

这两项清单和接口都已接受，但还没有接到界面或数据上，写插件时不要依赖：

- `enso.session.messages()` 始终返回 `UNSUPPORTED`。`session.read` 权限可以声明，目前没有效果。
- `message.action` 的 `position: 'left'`、`composer.activity`、`composer.dock` 注册后不会显示。

## 限制汇总

| 项 | 限制 |
| --- | --- |
| 清单 | 256KB |
| 插件包 | 5000 个文件、合计 200MB；zip 单文件 50MB、合计 100MB |
| 文件读写 | 单文件 5MB |
| 网络响应 | 5MB，最多 5 次重定向 |
| 工具结果 | 1MB，60 秒超时 |
| 界面调用 | 参数与返回值各 64KB；命令 60 秒，声明过的渲染方法按声明（最长 120 秒），其余 2 秒 |
| 宿主 MCP | 参数 64KB；单次最长 120 秒 |
| 配置项 | 最多 20 项，每个值 4096 字符 |
| 草稿写入 | 32KB |
| 系统通知 | 标题 200 字符，正文 1000 字符 |
| 补全 | 50 条，label 64 字符，detail 120 字符，插入文本 32KB |
| 调用频率 | 每插件每秒 10 次；连续失败 5 次熔断 30 秒 |
| 进程 | 启动限时 10 秒；空闲 5 分钟退出；10 分钟内崩溃 3 次自动停用 |

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
| `RATE_LIMITED` | 调用过于频繁 |
| `CIRCUIT_OPEN` | 连续失败，30 秒内拒绝 |
| `UNSUPPORTED` | 当前环境不支持（服务端的系统通知、尚未接通的会话消息、Agent 进程不可用时的 MCP 调用） |
