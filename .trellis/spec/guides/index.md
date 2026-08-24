# 思考流程

动手前先想清楚，比写完再排查便宜得多。本目录的四份指南针对本仓库最常见的失误类型。

| 指南 | 什么时候用 |
|------|-----------|
| [pre-implementation-checklist.md](pre-implementation-checklist.md) | 任何非平凡改动动手前 |
| [cross-layer-thinking-guide.md](cross-layer-thinking-guide.md) | 改动跨越主进程 / preload / 渲染层 |
| [code-reuse-thinking-guide.md](code-reuse-thinking-guide.md) | 准备新建文件或复制一段已有实现前 |
| [bug-root-cause-thinking-guide.md](bug-root-cause-thinking-guide.md) | 修完一个 bug 之后 |

## 本仓库的层

```
用户操作
  → 渲染层组件            src/renderer/components/
  → zustand store         src/renderer/stores/settings/
  → preload 出口          src/preload/index.ts
  → IPC handler           src/main/ipc/
  → service               src/main/services/
  → 文件系统 / 外部应用配置 / 网络
```

反向还有一条：主进程写入 settings 后广播 → 其它窗口 rehydrate → 副作用重放。

大多数难查的问题出在**层与层的交界**，而不是某一层内部。
