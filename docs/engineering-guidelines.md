# 工程开发约定

本文件是项目长期有效的开发规范，不依赖任何工作流工具。

## 技术边界

- Electron 43 + electron-vite，主进程 / preload / renderer 三段构建。
- React 19 + TypeScript，状态使用 Zustand；持久化主要落到主进程管理的 `settings.json`。
- UI 使用项目已有的 `src/renderer/components/ui/` 封装，不直接引入底层 UI 原语。
- 使用 pnpm、Biome、Vitest。
- 项目没有数据库、ORM、HTTP 服务端或路由库；不要为局部需求引入这些基础设施。
- 安装包：只有 main/worker 运行时 `require`/`import` 的包放 `dependencies`。renderer 库放 `devDependencies`，由 Vite 打进 `out/`，renderer `minify: 'esbuild'`。`electron-builder.yml` 排除 `*.map`、类型声明、文档和跨平台编译残留；非本平台 `better-sqlite3` 预编译由 `afterPack` 删除，不要写进 `mac.files`。

## 开发前

对跨模块、跨层、公开接口或非平凡改动，先写清四件事：

1. 现在的行为与目标行为差异。
2. 行为真正所属的层，而不是最方便拦截的层。
3. 每个需要修改的文件及原因。
4. 本次明确不处理的相邻问题。

优先复用已有模式：

- 外部配置扫描：`src/main/services/providerScan/` 或 `assetScan/`。
- 设置页列表、导入、编辑：现有 Providers / Skills 设置组件。
- 弹窗：`DialogHeader`、`DialogPanel`、`DialogFooter`。

## 测试与提交

可单测的纯逻辑、解析器、协议校验、路径校验和 reducer 遵循 Red-Green：

1. 先写能因缺少功能而失败的测试。
2. 写最小实现使其通过。
3. 跑 `pnpm test:changed`，再提交；跨模块改动再跑全量，见 [测试规范](engineering-reference/testing.md#跑哪些测试)。

重点覆盖：身份/去重定义、字符串拼接与解析、安全边界、坏配置和脏输入。文件读取测试使用临时目录，不依赖开发机上的真实配置。测试应断言可观察行为，不要只断言内部函数调用或错误文案。

涉及模型自主调用工具的功能，至少用两个不同厂商的模型做真机验证；工具 schema 必须声明完整类型，参数归一化发生在 schema 校验之前。

提交前运行：

```bash
pnpm typecheck && pnpm lint && pnpm test:changed
```

一个可独立描述的修复、功能或重构使用一个独立提交，不把无关改动混在一起。

## IPC 与安全边界

新增 IPC 能力必须同时完成三点：

1. `src/shared/types/ipc.ts` 中的通道常量。
2. `src/main/ipc/` 中的 handler，并在注册入口注册。
3. `src/preload/index.ts` 中按领域暴露的 typed API。

- IPC 入参一律按 `unknown` 收窄，不能用类型断言代替校验。
- Renderer 只传标识符，不传任意磁盘路径；路径由 Main 根据权威记录推导，并检查目录和文件名边界。
- API key、MCP env 明文只保留在 Main；Renderer 只接收脱敏候选。
- 不暴露通用 `invoke(channel, ...args)`。
- 跨 IPC 返回结构化结果 `{ ok, ... }`，不要直接把异常跨边界抛出。
- Main 向界面推送使用项目的 `sendToWindow` / `sendToAllWindows`，不要直接向没有 preload 的 shell webContents 发送。

## Main、worker 与会话

- `agentHost` 是 worker 生命周期边界；worker 事件必须先解析、收窄后再广播。
- worker 需要的代理等状态，在 worker ready 后重新推送；不能假设 fork 前发送的命令一定被接收。
- session 正文是可丢弃投影，worker / jsonl 才是权威源；reducer 负责事件归并，订阅回调不要承载业务逻辑。
- `message-upsert` 按索引整条替换，过期 seq 丢弃。
- 乐观回显不算权威正文。任何不会真正发给 worker 的操作，必须在乐观回显之前拒绝。
- capability 授权按 child generation 建键，不按内部 turnId；撤销边界是 child 生命周期。
- child 恢复由 Main 根据持久化记录级联完成，恢复时排除自身条目，避免自撞名。
- 对 pi 私有 API 的依赖必须封装、测试可观察结果，并记录升级复检点。

## 状态与持久化

- 大段正文、指令文件内容不要进入 `settings.json`；store 只保存元数据，正文放文件。
- 新增设置字段要同步类型、默认值、action、副作用应用逻辑，以及必要的 Main 去重逻辑。
- 外部实体删除时同时清理由应用创建的本地副本。
- 冷会话清空 messages 后不能把空数组当作权威历史；重新 hydrate 前不得聚合或保存基于当前磁盘内容重建的旧快照。
- Zustand 订阅要按字段选择，避免任意设置变化触发整页重渲染。

## 设置页 UI

设置页用 `src/renderer/components/settings/kit/` 里的组件拼，不自写行和分组：

- 一层容器。页面已经在主区卡片里，页内不再画带边框或 `bg-card` 的框。分组是标题加行间 1px 分隔线，组间留白 40px。主题缩略图这类「内容本身是对象」的预览可以有框，元素上标 `data-settings-preview`，里面不能再套框。
- 内容列最宽 920px（`--settings-content-max`），宽屏下居中，窄窗口铺满不横向溢出。
- 页头是标题、标签、说明加页级操作。标题区至少 280px，操作按钮放不下时整组换到标题下面，标签和标题按基线对齐。
- 设置行是左边标签加一行说明、右边控件。用 kit 的 `SettingsSwitch`、`SettingsSelect`、`SettingsSegmented`、`SettingsInput`、`SettingsStepper`、`SettingsButton`，它们会把控件和标签、说明关联起来。按钮、下拉、输入框就是 ui 组件的 `sm` 尺寸，和对话框、工作区同一套，不在 kit 或页面里改高度、圆角和字号；直接用 ui `SelectTrigger` 时也传 `size="sm"`。
- 服务商、插件、MCP 这类列表用 `SettingsExpandableRow`，展开后是缩进的 `SettingsSubRow`，不嵌卡片。
- 危险操作放在页面最后一个 `SettingsSection tone="danger"`，用 `SettingsDangerAction`，一律先弹确认。红色文字和描边用 `--destructive-text`。
- 文本框停止输入 600ms 或失焦即保存，行内显示「已保存」，不加保存按钮，也不弹 toast。
- 窄屏（/desk 390 宽）控件会换到标签下一行并靠右，触屏点击区域不小于 44px。

`components/settings/noNestedCards.test.ts` 会扫描设置页源码。还没迁移的页面在白名单里，迁完一页就删一行，白名单里的页面不再有框时测试会提醒删除。

## 扫描器与外部配置

扫描器遵循“来源定位 / 格式读取 / 编排去重”三层结构。读取器是纯函数，格式错误返回空结果；单个来源失败不能阻断整体扫描。重复项应标记而不是静默丢弃，并在扫描、批量导入、store 落库三层拦截。

身份定义必须明确：模型服务按 `baseUrl + apiKey`，技能按小写名称，MCP 按命令与参数或 URL，指令文件按内容 SHA-256。

## 变更后的排查顺序

遇到“状态不更新、历史为空、输入无响应、行为只在真机失败”等问题，沿完整链路检查：UI → store/reducer → preload → IPC → Main → worker / 文件 / 网络。症状位置不一定是根因位置；优先用 CDP、IPC 返回值和持久化文件验证可观察事实，不要只盯着当前组件猜测。
