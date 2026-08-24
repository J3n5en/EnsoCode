# 跨层改动思考指南

改动一旦跨越进程边界，最容易出的不是逻辑错误，而是**链路断裂**和**数据形状不一致**。

## 完整链路

以「从设置页触发一次扫描」为例，一条完整的往返：

```
组件 onClick
  → window.electronAPI.assets.scanLocal()        preload/index.ts
  → ipcRenderer.invoke(IPC_CHANNELS.ASSETS_SCAN_LOCAL)
  → ipcMain.handle(...)                          main/ipc/assets.ts     ← 参数校验
  → scanLocalAssets()                            main/services/assetScan/index.ts
  → 读文件 / sqlite / toml
  ← 返回脱敏候选 + scanId
  → setState 渲染列表
  → 用户确认 → collectImport(scanId, ids) 取回完整数据
  → store.addXxx() 落库 → persist → settings.json
  → 主进程广播 SETTINGS_CHANGED → 其它窗口 rehydrate
```

## 动手前逐项回答

### 1. 通道链路是否完整

新能力必须同时改三处，缺一处运行时才炸：

- [ ] `src/shared/types/ipc.ts` 的 `IPC_CHANNELS`
- [ ] `src/main/ipc/<域>.ts` 的 handler（并确认所在模块已在 `ipc/index.ts` 注册）
- [ ] `src/preload/index.ts` 的暴露方法

漏 preload → 渲染层 `Cannot read properties of undefined`；
漏注册 → `No handler registered for '...'`。

### 2. 数据在每层是什么形状

| 层 | 形状 | 注意 |
|----|------|------|
| service 内部 | 完整数据（含明文密钥、env 值） | 只留在主进程 |
| IPC 返回渲染层 | 脱敏（`apiKeyMasked` / `envKeys`） | 定义在 `shared/types` |
| store | 持久化形态 | 新字段可选，改名等于丢数据 |
| 组件 | 展示形态 | 路径转 `~/` 显示等 |

同一个概念在不同层可以有不同形状，但**转换点要唯一**。
比如路径的 `~/` 展示化统一在 `displayPath()` 里做，不要各处 replace。

### 3. 入参不可信

handler 收到的一切都是 `unknown`，逐个 `typeof` 收窄，数组逐项过滤。
不要用 `as` 断言代替校验。写文件类通道额外问一句：
**攻击者控制这个参数能写到哪里**。

### 4. 错误怎么跨层

不要跨 IPC 抛异常（堆栈和类型都会丢）。返回 `{ ok, ...,  error? }`，
渲染层据 `ok` 分支并把 `error` 展示出来。

### 5. 谁需要知道这次变化

- 改了 store 字段 → 主进程 `existingKeys()` 是否也在读它？
- 加了有副作用的设置 → `applySettings()` 补了吗？（否则多窗口不同步）
- 加了外部落地物（文件） → 删除时清理了吗？

## 验证

跨层问题靠读代码容易漏，用真机验证最快：注入调试端口，
用 CDP 直接调 `window.electronAPI.xxx()` 看返回值，
或读 `settings.json` 看落库结果。方法见
[../shared/conventions.md](../shared/conventions.md)。

注意：**改主进程代码需要重启 dev**，只有渲染层有 HMR。
验证时如果行为没变，先确认是不是这个原因。
