# 工程参考

这些文档由原项目工程规范整理而来，内容以当前源码为准，不依赖任何外部工作流工具。

- `main/`：Electron 主进程、IPC、services、窗口和持久化。
- `renderer/`：React 组件、状态、样式、国际化。
- `shared/`：共享类型、约定和调试验证。
- `guides/`：跨层改动、复用、根因分析和动手前检查。
- `big-question/`：项目真实踩过的高代价陷阱。
- `testing.md`：Vitest、测试边界和真机验证要求。

日常开发先读 `AGENTS.md` 与 `docs/engineering-guidelines.md`；需要深入某一层时再读本目录对应文档。
