# enso-code 开发规范

> Electron 多窗口脚手架，React 19 + TypeScript。本目录的规范全部来自本仓库的真实代码，
> 每条规则都能在 `src/` 下找到对应文件。

---

## 技术栈

| 领域 | 选型 | 关键约束 |
|------|------|----------|
| 桌面框架 | Electron 43 + electron-vite 5 | `electron.vite.config.ts` 三段构建（main/preload/renderer） |
| 界面 | React 19.2 + TypeScript 7 | TS 7 已移除 `baseUrl`，路径别名用相对写法 |
| 样式 | Tailwind 4.3（`@theme` 内联令牌） | 见 `src/renderer/styles/globals.css` |
| 组件 | `@base-ui/react` 封装于 `src/renderer/components/ui/` | 约 50 个封装组件，不直接用 base-ui 原语 |
| 状态 | zustand 5 + persist | 唯一 store：`src/renderer/stores/settings/` |
| 持久化 | 主进程 `settings.json` | 无数据库、无 ORM |
| 工具链 | Biome 2.5、pnpm 10、Vitest 4 | `pnpm typecheck` / `pnpm lint` / `pnpm test` |

**本项目没有的东西**（不要引入或假设其存在）：数据库与 ORM、事务、分页、HTTP 服务端、
路由库。`better-sqlite3` 与 `level` 仅用于**只读**扫描其它应用的配置，
见 `src/main/services/providerScan/readers.ts`。

---

## 目录与规范对应

| 源码目录 | 职责 | 规范 |
|----------|------|------|
| `src/main/` | Electron 主进程：窗口、IPC、文件与数据库读取 | [main/index.md](main/index.md) |
| `src/preload/` | contextBridge 单一出口 `electronAPI` | [main/ipc.md](main/ipc.md) |
| `src/renderer/` | 两个入口窗口的 React 应用 | [renderer/index.md](renderer/index.md) |
| `src/shared/` | 主进程与渲染层共享的类型和文案 | [shared/index.md](shared/index.md) |

其它：

- [big-question/index.md](big-question/index.md) —— 本仓库真实踩过、排查代价高的坑
- [guides/index.md](guides/index.md) —— 跨层改动、代码复用、根因分析的思考流程
- [testing.md](testing.md) —— 测什么、怎么测、私有函数如何暴露

---

## 动手前

1. 读目标层的 `index.md`，按其中的 Pre-Development Checklist 逐项确认。
2. 涉及主进程与渲染层之间的数据传递，先读 [guides/cross-layer-thinking-guide.md](guides/cross-layer-thinking-guide.md)。
3. 提交前跑：

```bash
pnpm typecheck && pnpm lint && pnpm test
```

三者都必须干净。测试约定见 [testing.md](testing.md)。`pnpm lint` 输出里那条 `biome.json` 的 `recommended` 字段弃用提示（`Found 1 info`）
是配置本身的历史遗留，与代码无关，不必处理。
