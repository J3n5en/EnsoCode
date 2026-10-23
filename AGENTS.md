# EnsoCode 开发约定

本文件是项目对人类和 AI 贡献者都适用的长期约定。

## 开发原则

- 变更范围保持最小，不做无关重构或功能扩展。
- 跨模块、跨层或公开接口改动，先写清行为差距、所属层、必改文件和明确不做的相邻问题。
- 优先复用现有实现模式；详细规范见 [`docs/engineering-guidelines.md`](docs/engineering-guidelines.md)。
- 非平凡改动、排障或发现可复用经验时，使用 [`project-knowledge`](.agents/skills/project-knowledge/SKILL.md) 检索和沉淀项目知识。
- 真实排查过的高代价陷阱见 [`docs/engineering-reference/big-question/`](docs/engineering-reference/big-question/)。
- Windows 本地打包先读 [打包操作指南](docs/engineering-reference/guides/EnsoCode_Windows本地打包_操作指南.md)，直接使用固定入口 `node scripts/build-win-local.mjs`；复用适用于当前源码的验证证据，仅在实际失败时按指南排查，不重复探索已解决的环境问题。

## 测试先行

凡是改动可单测逻辑（纯函数、解析器、协议校验、路径校验、store reducer 等），按 Red-Green 循环：

1. 先写测试并确认它因缺少功能而失败；
2. 写最小实现使测试通过；
3. 跑全量测试后再提交。

重点覆盖身份/去重定义、字符串拼接与解析、安全边界、坏配置和脏输入。文件读取测试使用临时目录，不依赖开发机真实配置。测试应断言可观察行为，而不是只断言内部调用或错误文案。

涉及模型自主调用工具的功能，至少使用两个不同厂商的模型真机验证；工具 schema 必须声明完整类型，参数归一化必须发生在 schema 校验之前。

## 提交前检查

```bash
pnpm typecheck && pnpm lint && pnpm test
```

一个可独立描述的修复、功能或重构使用一个独立提交，不把无关改动混在一起。

## 关键边界

- 新增 IPC 必须同步修改通道常量、Main handler 注册和 preload typed 出口。
- IPC 入参一律按 `unknown` 收窄，不能用类型断言代替校验。
- Renderer 只传标识符，不传任意磁盘路径；路径由 Main 根据权威记录推导并校验边界。
- API key、MCP env 明文只保留在 Main；不要暴露通用 IPC 调用入口。
- 会话正文是可丢弃投影，worker / jsonl 才是权威源；reducer 负责事件归并，过期 seq 丢弃。
- 任何不会真正发给 worker 的操作，都必须在 optimistic echo 之前拒绝。
- capability 授权按 child generation 建键，不按内部 turnId；child 恢复由 Main 级联完成。
- 大段文本不要写进 `settings.json`；外部实体删除时同时清理由应用创建的本地副本。
- 扫描器遵循“来源定位 / 格式读取 / 编排去重”三层结构；单个来源失败不能阻断整体扫描。

## 排查方式

遇到状态不更新、历史为空、输入无响应或只在真机失败的问题，沿完整链路检查：

```text
UI → store/reducer → preload → IPC → Main → worker / 文件 / 网络
```

症状位置不一定是根因位置。优先用 CDP、IPC 返回值和持久化文件验证可观察事实，不要只盯着当前组件猜测。
