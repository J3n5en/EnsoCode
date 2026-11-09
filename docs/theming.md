# 主题

主题给界面换一套颜色。内置三套，插件可以再贡献，用户还可以写自己的 CSS。这一页只记事实。写插件的步骤在最后一节。

## 来源和注入顺序

三种来源：

- 内置主题 `enso`、`graphite`、`paper`。默认 `enso`。模块初始化时就写上，避免闪一下。
- 插件主题。键是 `<插件 id>/<主题 id>`。文件要异步读，读完之前保持上一个主题。
- 用户 CSS。开关打开时盖在最上面。

设置项 `appearance.themeId` 存主题键。插件被停用或卸载、键解析不到时，界面回落 `enso`，不改写这项设置。插件恢复后自动回来。主题 id 本身匹配 `^[a-z][a-z0-9-]{0,31}$`，不能含 `/`。插件 id 仍是清单里的反向域名。

`<html>` 上有 `data-theme`，值是当前解析到的主题键。深色模式仍用 `.dark`，不要改这个类名。

`<head>` 末尾按这个顺序放三个 `<style>`，后面的盖住前面的：

1. `enso-theme-tokens`。当前主题派生出的变量。
2. `enso-theme-css`。当前主题自带的 CSS。内置主题这里是空的。
3. `enso-user-css`。`userData/user.css`。`appearance.userCssEnabled` 为 false 时不注入。默认 false。

token 那一块写成两段，选择器是 `:where(:root)` 和 `:where(:root.dark)`。`:where()` 的优先级是 0，所以插件或用户 CSS 里普通的 `:root`、`.dark` 规则就能盖住它们。再往后，优先级相同的规则按上面的顺序，用户 CSS 盖插件 CSS，插件 CSS 盖 token。优先级更高的选择器不受这个顺序限制。

## 调色板

一个主题必须给出浅色和深色两套调色板。值是 CSS 颜色，可以是 hex、`rgb()`、`oklch()` 或 `color-mix()`。九个字段都要写。值不能为空，也不能含有 `;`、`{`、`}`、`<`、`>`、反斜杠、换行或 `/*`。任一字段不合格，整个主题解析失败。规则与下面的 tokens 相同，以 `src/shared/theme/tokensCss.ts` 为准。

| 字段 | 含义 |
| --- | --- |
| `canvas` | 窗口画布。侧栏直接坐在上面。 |
| `surface` | 主内容卡片、右面板、弹层。 |
| `sunken` | 代码块、diff 和其他凹面。 |
| `border` | 常规分隔线。 |
| `borderStrong` | 输入框和控件描边。 |
| `text` | 正文。 |
| `textMuted` | 次要文字。 |
| `textSubtle` | 弱化文字，例如工具日志。 |
| `accent` | 品牌强调色。运行点、勾选、计划模式和链接用它。不要拿它铺大块背景。 |

外观页的强调色可以换成预设，盖住调色板的 `accent`。设置项 `appearance.accentColor` 的值是 `theme`、`violet`、`indigo`、`teal`、`amber`、`graphite`。`theme` 表示沿用调色板，这是默认。其余五个用固定的浅色和深色，见 `src/shared/accentColor.ts`。

## 派生变量

`deriveThemeTokens` 把一套调色板变成下面这些变量。`color-mix` 都写在 oklch 里，形式是 `color-mix(in oklch, <颜色> <百分比>%, <底>)`。表里的 `text`、`surface`、`canvas`、`sunken`、`border`、`borderStrong`、`textMuted`、`textSubtle` 是调色板字段，不是同名 CSS 变量。`brand` 是强调色预设，没有预设时就是调色板的 `accent`。

状态色和浮层阴影不进调色板，按模式取固定值。主题要改它们，用下一节的 tokens。

| 变量 | 值 |
| --- | --- |
| `--canvas` | `canvas` |
| `--background` | `surface` |
| `--foreground` | `text` |
| `--card` | 深色 `color-mix(in oklch, text 3%, surface)`。浅色 `surface`。 |
| `--card-foreground` | `text` |
| `--popover` | 深色 `color-mix(in oklch, text 5%, surface)`。浅色 `surface`。 |
| `--popover-foreground` | `text` |
| `--primary` | `text` |
| `--primary-foreground` | `surface` |
| `--secondary` | `color-mix(in oklch, text 6%, surface)` |
| `--secondary-foreground` | `text` |
| `--muted` | 深色 `color-mix(in oklch, text 7%, surface)`。浅色 `color-mix(in oklch, text 4.5%, surface)`。 |
| `--muted-foreground` | `textMuted` |
| `--subtle-foreground` | `textSubtle` |
| `--sunken` | `sunken` |
| `--accent` | `color-mix(in oklch, text 6%, transparent)`。悬停和选中的填充，不是调色板的 accent 字段。 |
| `--accent-foreground` | `text` |
| `--border` | `border` |
| `--input` | `borderStrong` |
| `--ring` | `color-mix(in oklch, brand 50%, transparent)` |
| `--brand` | 强调色预设，否则是调色板 `accent` |
| `--brand-foreground` | 深色 `canvas`。浅色固定 `oklch(0.985 0 0)`。 |
| `--elevation-surface` | 浅色 `0 0 0 1px color-mix(in oklch, text 7%, transparent), 0 1px 3px rgb(0 0 0 / 0.04)`。深色 `0 0 0 1px color-mix(in oklch, text 6%, transparent), 0 2px 8px rgb(0 0 0 / 0.3)`。 |
| `--destructive` | 浅色 `oklch(0.577 0.245 27.33)`。深色 `oklch(0.396 0.141 25.72)`。 |
| `--destructive-foreground` | `oklch(0.985 0 0)` |
| `--success` | `oklch(0.527 0.154 150.07)` |
| `--success-foreground` | `oklch(0.985 0 0)` |
| `--warning` | `oklch(0.769 0.189 70.08)` |
| `--warning-foreground` | `oklch(0.205 0.014 285.82)` |
| `--info` | `oklch(0.623 0.214 259.81)` |
| `--info-foreground` | `oklch(0.985 0 0)` |
| `--elevation-float` | 浅色 `0 1px 2px oklch(0.2 0.01 285 / 0.05), 0 12px 32px -12px oklch(0.2 0.02 285 / 0.18)`。深色 `0 1px 2px oklch(0 0 0 / 0.3), 0 16px 40px -12px oklch(0 0 0 / 0.55)`。 |

## 用 tokens 覆盖

主题 JSON 可以带 `tokens.light` 和 `tokens.dark`。键是 CSS 变量名，必须匹配 `^--[a-z0-9-]+$`。值在派生之后叠上去，同名键替换派生值。值为空，或含有 `;`、`{`、`}`、`<`、`>`、反斜杠、换行、`/*` 的声明会被丢掉。

主题文件的形状：

```json
{
  "light": { "canvas": "#d8dee9", "surface": "#eceff4", "sunken": "#e5e9f0", "border": "#d8dee9", "borderStrong": "#4c566a", "text": "#2e3440", "textMuted": "#3b4252", "textSubtle": "#4c566a", "accent": "#88c0d0" },
  "dark": { "canvas": "#2e3440", "surface": "#3b4252", "sunken": "#2e3440", "border": "#434c5e", "borderStrong": "#4c566a", "text": "#eceff4", "textMuted": "#e5e9f0", "textSubtle": "#d8dee9", "accent": "#88c0d0" },
  "tokens": { "dark": { "--destructive": "oklch(0.7 0.14 25)" } }
}
```

浅色和深色与 `examples/plugins/theme-nord` 相同。`tokens` 只演示覆盖，那个插件文件里没有这一段。

## 锚点

组件上的 `data-enso` 是稳定选择器。插件 CSS 和用户 CSS 用 `[data-enso="canvas"]` 这种写法，不要依赖内部 class。下表与 `src/shared/theme/anchors.ts` 的 `THEME_ANCHORS` 一致，顺序也相同。

| 锚点 | 位置 |
| --- | --- |
| `canvas` | 主窗口和设置窗口的画布。侧栏坐在上面。 |
| `sidebar-toggle` | 展开 / 折叠侧栏的按钮。窗口顶栏左侧那个，移动端顶栏打开抽屉的按钮和抽屉底部的收起按钮也挂。 |
| `search-button` | 「Search anything」搜索按钮。窗口顶栏那个和移动端抽屉底部那个。 |
| `new-session` | 窗口顶栏的新建会话按钮。 |
| `sidebar` | 会话侧栏。 |
| `group-chip` | 侧栏顶部分类条里的每个分组标签：全部、最近、自定义分组、未分组。 |
| `section-header` | 侧栏列表里的分区标题，带 `data-section`。 |
| `project-row` | 侧栏里的项目行，只是那一行，不含下面的会话。 |
| `tree-chevron` | 侧栏里可折叠行的展开箭头：项目行、临时会话分区标题、分组标题。 |
| `session-row` | 侧栏里的会话行。 |
| `session-status` | 会话行里的状态圆点。空闲且没有未读时不画圆点，也就没有这个元素。 |
| `row-menu` | 侧栏项目行悬停时出现的「…」更多操作按钮。 |
| `node-switcher` | 侧栏底部的设备切换按钮。 |
| `settings-button` | 侧栏底部和折叠栏里的设置按钮。 |
| `main` | 主内容卡片。 |
| `title-bar` | 卡片顶栏。聊天、设置和整行标题栏都挂它。 |
| `session-tabs` | 会话标签行。 |
| `side-panel` | 右侧面板。 |
| `timeline` | 消息时间线。 |
| `message-user` | 用户消息。 |
| `message-assistant` | 助手消息。 |
| `tool-row` | 工具调用行。 |
| `thinking` | 思考块。 |
| `todo` | 待办。时间线里的待办面板和输入框上的待办条都挂它。 |
| `code-block` | 代码块。 |
| `approval` | 输入框上方的工具审批卡。 |
| `composer` | 输入框。 |
| `status-line` | 状态行。 |
| `settings-nav` | 设置导航。 |
| `settings-content` | 设置内容。 |

## 状态

主窗口在 `<html>` 上写两个状态属性，值都是 `idle`、`running`、`waiting`、`error` 之一，含义和优先级与插件 `session_status` 事件相同，见 [插件](plugins.md) 的「会话状态」：

- `data-enso-activity`：所有主会话里优先级最高的状态。
- `data-enso-session`：当前打开的会话的状态。没有打开会话时是 `idle`。

`waiting` 包括等待回答的提问、等待审批的工具调用和能力确认。未读不算状态。设置窗口不写这两个属性。

思考块 `[data-enso="thinking"]` 在思考进行中带 `data-live`，结束后去掉。

侧栏和审批卡上的控件级属性。布尔属性存在即为真，为假时不渲染这个属性：

- `data-active`：`group-chip` 是当前选中的分组；`session-row` 是当前打开的会话。
- `data-expanded`：`project-row` 和 `tree-chevron` 处于展开状态。搜索时项目一律展开。
- `data-section`：`section-header` 的分区，取值 `active`（活跃中）、`pinned`（置顶会话）、`scratch`（临时会话）、`projects`（项目）、`pinned-projects`（置顶项目）、`group`（「全部」视图下的分组标题，含未分组）。
- `data-status`：`session-row` 和 `session-status` 上，值是 `idle`、`running`、`waiting`、`error` 之一，算法与 `data-enso-session` 相同，只是对象换成这一行的会话。
- `data-unread`：`session-row` 有未读回复。未读不改变 `data-status`。

```css
:root[data-enso-session="error"] [data-enso="composer"] { border-color: var(--destructive); }
[data-enso="thinking"][data-live]::before { background-image: var(--my-busy); }
[data-enso="session-row"][data-status="waiting"] [data-enso="session-status"] { background-image: var(--my-ask); }
```

这些属性和锚点一样是稳定接口，不要再用内部类名（例如 `.animate-pulse`）推断状态。

## 素材槽位

主题 JSON 可以加 `assets`，把图片放进预设位置，不用写 CSS。每个槽位一张默认图，可选三种变体：

```json
"assets": {
  "thinking": {
    "src": "assets/busy.webp",
    "still": "assets/busy-still.webp",
    "dark": "assets/busy-dark.webp",
    "states": { "running": "assets/run.webp", "waiting": "assets/ask.webp", "error": "assets/oops.webp" }
  }
}
```

- `still`：系统开了「减少动态效果」时用它。`thinking` 槽位的思考块不在进行中（没有 `data-live`）时也用它。
- `dark`：深色模式用它。
- `states`：键只能是 `running`、`waiting`、`error`，按下表的状态来源切换。状态图优先于 `dark` 和 `still`，所以状态图最好本身不动。

| 槽位 | 位置 | 默认摆法 | 状态来源 |
| --- | --- | --- | --- |
| `canvas-pattern` | 主窗口画布底纹 | 铺满平铺，在内容下面 | `data-enso-activity` |
| `sidebar-footer` | 侧栏背景底部 | 居中，离底 64px，宽 `min(150px, 80%)` | `data-enso-activity` |
| `empty-main` | 没有会话时的主区背景 | 居中偏上 130px，宽 170px | `data-enso-activity` |
| `welcome` | 新会话还没有用户消息时，时间线右下角 | 右 24px、下 12px，132×132 | `data-enso-session` |
| `composer-peek` | 从输入区上沿探头，聚焦时弹起 | 右 72px，84×66，底边对齐 | `data-enso-session` |
| `thinking` | 思考块左侧 | 34×34，思考块左缩进 36px | `data-enso-session` |
| `code-corner` | 代码块右上沿 | 右 20px、上 -13px，24×24 | `data-enso-session` |
| `todo-corner` | 时间线里待办卡片右上沿，紧贴输入框的那张不挂 | 右 6px、上 -30px，44×44 | `data-enso-session` |
| `status-icon` | 状态行左侧 | 左 2px、垂直居中，20×20 | `data-enso-session` |
| `panel-corner` | 右侧面板右下角 | 右下各 10px，72×72，不透明度 0.9 | `data-enso-session` |

路径按主题 JSON 所在目录解析，必须是插件目录内的相对路径：不能以 `/` 开头，不能含 `..`、`.` 段、空段、反斜杠、`:`、`%`、`?`、`#`、引号、括号或空白。扩展名限 png、jpg、jpeg、gif、webp、bmp、svg、jfif、avif。不认识的槽位、不合法的路径或状态名只让这一个槽位作废，主题照常加载。

生成的 CSS 放在主题 `css` 前面，每个槽位还有一个变量 `--enso-asset-<槽位>`，值是当前生效的 `url()`。主题 CSS 可以覆盖槽位的摆法，也可以引用变量叠加别的图层。只有 `assets`、没有 `css` 的主题不需要「修改界面样式」同意。槽位表和生成逻辑在 `src/shared/theme/assets.ts`，它只依赖同目录模块，主题生成器会原样拷用。

## 主题背景

主题 JSON 可以加 `background`，带一张铺满窗口的壁纸，参数和外观页「背景图」那组设置同义：

```json
"background": {
  "image": { "src": "assets/background.webp", "dark": "assets/background-dark.webp" },
  "size": "cover",
  "opacity": 0.85,
  "blur": 0,
  "brightness": 1,
  "saturation": 1,
  "mask": 0.5,
  "composerOpacity": 0.6,
  "codeOpacity": 0.65
}
```

`image` 和素材槽位的写法一样，`still`、`dark`、`states` 都能用，状态跟 `data-enso-activity`。路径规则同上。`image` 不合法时整个 `background` 作废，主题照常加载。

| 字段 | 对应设置 | 范围 | 默认 |
| --- | --- | --- | --- |
| `size` | 填充方式 | `cover`、`contain`、`repeat`、`center` | `cover` |
| `opacity` | 背景可见度，即整张壁纸的不透明度；普通面板全透，弹出层保底 0.92 | 0–1 | 0.85 |
| `blur` | 模糊，单位 px | 0–20 | 0 |
| `brightness` | 亮度 | 0–2 | 1 |
| `saturation` | 饱和度 | 0–2 | 1 |
| `mask` | 遮罩，按画布色压暗或提亮 | 0–1 | 0.5 |
| `composerOpacity` | 输入框不透明度 | 0–1 | 0.6 |
| `codeOpacity` | 代码块不透明度 | 0–1 | 0.65 |

越界的数值钳到范围内，不是数字或不认识的 `size` 只丢这一个字段，缺的字段取默认值。

用户在外观页自己开了背景图时，用户的设置优先，主题背景不生效。用户没开时，主题背景按上表参数生效，界面和用户背景图一样变成半透明面板。外观页会提示「当前主题自带背景」。主题背景只支持图片，不支持视频、文件夹随机和网络地址。图片地址在变量 `--enso-asset-background` 里，由背景层引用。谁生效由 `src/renderer/lib/effectiveBackground.ts` 判定。

## 用户 CSS

外观页有「自定义 CSS」开关，对应 `appearance.userCssEnabled`，默认关。旁边是「打开 user.css」。文件是 Main 拥有的 `userData/user.css`，不写进 `settings.json`。文件还不存在时，打开动作会先写入一份模板，再用系统默认程序打开。保存后界面跟着变，不用重启。关掉开关就不再注入这份文件。

## 安全

调色板只换变量。主题的 `css` 是开放的，选择器不受限制，可以改应用里任意界面。因此带 `css` 的主题在安装和更新时要单独同意。对话框写的是「修改界面样式：主题 CSS 可以改变应用的任意界面」。一个插件只要有一项主题带了 `css`，就有这项能力。从没有变成有，要重新同意。不带 `css` 的主题没有这项。不要把样式写进 `permissions`，未知名字会被拒绝。

主窗口和设置窗口的 CSP 里，`style-src` 只有 `'self'` 和 `'unsafe-inline'`。注入的 `<style>` 能生效，远程样式表和 `@import` 不能。`font-src` 只有 `'self'` 和 `data:`。`local-image:` 协议本身绕过 CSP。不要在主题 CSS 里写远程 `url()`。

主题 CSS 可以用相对 `url()` 引用插件目录里的图片和字体。扩展名是 png、jpg、jpeg、gif、webp、bmp、svg、jfif、avif、woff2、woff、ttf、otf。加载时按 CSS 文件所在目录解析，并改写成 `local-image://plugin-asset/...`。只改写 `url()`，`image-set("a.png")` 这类字符串写法要改成 `image-set(url("a.png"))`。越出插件目录或带反斜杠转义的地址不改写。只有已启用插件的文件能读到。

主题 CSS 里不能出现 `local-image`，注释里也不行，CSS 转义或百分号编码拼出来的也算。出现则整份主题解析失败。`local-image` 还能代理远程地址、读本机任意图片，这条检查挡住的是这两种用法。`user.css` 不改写，也不做这条检查。解析失败的主题不进画廊，错误显示在该插件那一行。

## 写一个主题插件

1. 建一个目录，放 `enso-plugin.json`。`schemaVersion` 为 `1`，`permissions` 为 `[]`。不需要 `main`。
2. 在 `contributes.themes` 里加一项。`id` 不含 `/`，并匹配 `^[a-z][a-z0-9-]{0,31}$`。`path` 是插件目录内的相对路径，以 `.json` 结尾，不能是绝对路径，不能含 `..` 或反斜杠。
3. JSON 里写全 `light` 和 `dark` 的九个字段。要改某一个派生变量，再加 `tokens`。要放角色图，加 `assets`，见「素材槽位」。要带壁纸，加 `background`，见「主题背景」。
4. 需要改圆角、间距或锚点上的布局时，再加 `css`，路径以 `.css` 结尾。只使用 `data-enso` 和上面的变量。可以用相对 `url()` 引用插件目录内的图片和字体。不要加载远程资源。这一步会触发「修改界面样式」的同意。
5. 设置里安装这个目录并启用。外观页的画廊里选它。插件停用后界面回到 `enso`，设置里的键还在。

只换颜色的例子是 `examples/plugins/theme-nord`。调色板加 CSS 的例子是 `examples/plugins/theme-catppuccin`。清单字段也写在 [插件](plugins.md) 的「贡献」里。
