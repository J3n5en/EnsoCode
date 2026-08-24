# 代码约定

## 注释

用**中文**写注释，解释「为什么」而不是「是什么」。仓库里的实际风格：

```ts
// 原子写入：先写临时文件再重命名，避免崩溃导致文件损坏
// setWindowButtonVisibility 会把按钮位置重置为系统默认，恢复显示时需要重新设置
// 仅保留最近一次扫描，供确认导入时取回完整数据（含 env 明文）
```

遵循「非必要不形成」：能从函数名和类型看懂的不写注释。值得写的是约束、代价、
以及为什么不能用更直白的写法。导出的函数用 JSDoc 单行说明用途，
例见 `src/main/services/instructionStore.ts`。

## 命名

| 对象 | 规则 | 例 |
|------|------|-----|
| 组件文件 | PascalCase | `ProviderEditDialog.tsx` |
| UI 基础组件文件 | kebab-case | `components/ui/scroll-area.tsx` |
| 其它模块 | camelCase | `providerApi.ts`、`ghosttyTheme.ts` |
| 服务目录 | camelCase + `index.ts` 编排 | `services/providerScan/` |
| 类型 | 名词，不加 `I` 前缀 | `ModelProvider`、`ScanCandidate` |
| 布尔量 | `is` / `has` / `should` 开头 | `isUsableApiKey`、`duplicated` |

## Biome

配置见 `biome.json`。关键项：单引号、分号必加、行宽 100、两空格缩进、
`trailingCommas: es5`。已关闭 `noExplicitAny` 和 `noNonNullAssertion`，
但这不代表鼓励使用 —— 优先写准确类型。

未使用的导入和变量是 `warn` 级别，**不要留**。修复用：

```bash
pnpm lint:fix     # 自动修格式和可自动修的规则
pnpm lint         # 只检查
```

`pnpm lint` 末尾恒定输出一条 `Found 1 info`，来自 `biome.json` 里 `recommended` 字段的
弃用提示，与代码无关。判断是否干净看有没有 `×` 开头的错误行。

## 提交

- 提交信息用**中文**，前缀 `feat:` / `fix:` / `refactor:` / `chore:`。
- **小步提交**：一个能独立描述的改动就提交一次，不要把多个特性攒成一个大提交。
- 提交前 `pnpm typecheck && pnpm lint && pnpm test` 必须干净。
- 提交前确认没有调试残留：

```bash
command grep -rn "TEMP-DEBUG\|remote-debugging-port\|console.log(" src/
```

## 变更范围

只对需求做针对性改动。看到顺手能改的无关问题，先说出来再决定，不要夹带进当前改动。

## 本地调试真机验证

需要在真实窗口里验证时，临时往 `src/main/index.ts` 注入调试端口：

```ts
app.commandLine.appendSwitch('remote-debugging-port', '9222'); // TEMP-DEBUG
```

然后 `pnpm dev`，通过 CDP（`http://127.0.0.1:9222/json/list` 拿到 WebSocket 地址，
Node 24 有原生 `WebSocket`，不需要装 `ws`）驱动界面、截图、读取状态。

**dev 模式只热重载 renderer**：`src/main/`、`src/preload/`、`src/agent/` 的改动
不会触发 rebuild 或重启，改完必须手动重启 `pnpm dev`，否则跑的还是旧产物
（agent worker 的行为 bug 尤其容易被这个假象掩盖）。

CDP 里驱动 renderer 模块可以用 vite 的动态 import——注意 renderer 的 vite root 是
`src/renderer`，模块路径是 `/stores/...` 而不是 `/src/renderer/stores/...`。

**验证完必须清理**：删掉 `// TEMP-DEBUG` 那行、结束 dev 进程、还原测试期间写入的
`settings.json` 与 `userData/instructions/`。改动过用户真实文件（如 `~/.factory/AGENTS.md`）
的测试，事前备份、事后用 md5 核对已还原。
