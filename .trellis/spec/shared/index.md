# shared 层规范

`src/shared/` 是主进程与渲染层**共同导入**的唯一目录。它不能依赖 `electron`、
不能碰 `node:fs`、也不能引用 React —— 因为同一份代码会同时被打进主进程包和浏览器包。

## 唯一例外：`src/shared/providers/`

上面那条「不碰 `node:*`」对 `src/shared/` 的**根目录与 `types/`** 是硬规矩。唯一例外是
`src/shared/providers/`，它依赖 `node:http` 与 `node:crypto`。

为什么必须开这个口子：agent worker（`src/agent/`）按 [main/services.md](../main/services.md)
的规定**只准 import `@shared` 与 pi sdk**，而订阅 provider（如 Antigravity）的注册在
主进程与 worker 两侧都要做一遍——worker 侧不注册，选到该 provider 的模型推理起不来。
于是「主进程 + worker 共用、渲染层碰不到」的运行时代码在本仓没有别的落点。

守卫是结构性的，不靠自觉：`tsconfig.web.json` 把 `src/shared/providers/**` 从 include 里
排除了。渲染层一旦 import 它，`pnpm typecheck` 立刻报「找不到模块」——错误停在类型检查，
而不是等 vite 打包 renderer 时炸在 node 内置模块上（那个报错很难认）。

⛔ 往这个目录加东西前先问：**渲染层真的永远不需要它吗？** 需要就说明它该拆成两半——
纯类型/纯逻辑那半放 `shared/types/`，碰 node 的那半留在这里。

## 文件

| 文件 | 内容 |
|------|------|
| `src/shared/types/ipc.ts` | `IPC_CHANNELS` 常量表，所有通道名的唯一来源 |
| `src/shared/types/llm.ts` | 模型服务领域类型（`ModelProvider` / `ModelEntry` / `ModelApiKind`） |
| `src/shared/types/assets.ts` | 技能 / MCP / 指令文件的登记类型 |
| `src/shared/types/providerScan.ts`、`assetScan.ts` | 扫描与导入的传输类型 |
| `src/shared/types/providerApi.ts` | 拉取模型与连通性测试的出入参 |
| `src/shared/types/index.ts` | 桶文件，对外只从这里导入 |
| `src/shared/i18n.ts` | 中文翻译表与 `translate()` |

## Pre-Development Checklist

动手前逐项确认：

- [ ] 新类型该放 `shared/types/` 还是某一层内部？**只有跨进程传输的类型**才进 shared。
- [ ] 新 IPC 通道名是否已加入 `IPC_CHANNELS`？不要在任何地方写字符串字面量。
- [ ] 新增的用户可见英文文案，是否已在 `src/shared/i18n.ts` 补上中文？
- [ ] 改动的类型是否会被持久化进 `settings.json`？若是，考虑旧数据的兼容（见 [types.md](types.md) 的"持久化类型"一节）。
- [ ] 是否误在 shared 里引入了 `electron` / `node:*` / React 依赖？（`providers/` 是唯一例外，见上）

## 详细规范

- [types.md](types.md) —— 类型组织、IPC 通道常量、持久化类型的演进
- [conventions.md](conventions.md) —— 命名、注释、Biome 配置、提交规范
