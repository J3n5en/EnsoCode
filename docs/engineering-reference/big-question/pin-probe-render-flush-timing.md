# pin 快照探针的 reset act 是 effect 链的冲刷时机，不是可省略的渲染

## 症状

优化 `systemGroup/appGroup/memoryGroup/modelsGroup` pin 快照测试性能时，两个看似等价的
「跳过重复渲染」都导致快照字节级失配：

1. reset 去重：store replace 后引用不变时跳过起始 reset act——memory 组条件渲染区块
   消失、跨页 IPC 调用漏测。
2. 惰性恢复：收尾只恢复 store 不渲染，把恢复渲染合并到下一控件 click——`electronAPI`
   测量窗口互相污染（updater/proxy 调用串进后续控件的 api 记录）。

## 根因

`probe()` 的每次 `effect()` 含两次 `act`：起始 reset + 收尾 reset。这两次 act 不只是渲染，
更是页面**重载 effect 链的收敛窗口**：

- 控件点击写 store → 页面 `useEffect` 派发 IPC（memory.list/stats、proxy.apply 等）→
  IPC 回填 store → 链式 effect 收尾。链的收敛依赖 act 的微任务/宏任务冲刷节奏。
- 起始/收尾 reset 恰好各提供一个冲刷点。去掉任何一个，链的收尾会漂进下一控件的新世代
  窗口（generation 由 async_hooks AsyncLocalStorage 传播），IPC 调用记到错误的控件名下。
- 同时，组件 local state（如 TerminalSettings 里内嵌的 FileOpeningSettings）的演化依赖
  重渲节奏；少一次渲染，条件渲染的区块在扫描时与测量时状态不同。

另外 zustand 语义：replace 后引用不变时订阅者不触发——但组件的 effect 链收敛仍然需要
act 冲刷窗口，两者不能混为一谈。

## 修法

每控件两次 act（起始 reset + 收尾 reset）是 pin 探针的语义下界，不可合并、不可惰性化。
性能优化只能作用于每次渲染的成本本身，不能动冲刷时机：

- `react/jsx-dev-runtime` 换成生产语义实现（vitest.config.ts alias 到
  `test/stubs/react-jsx-dev-runtime.ts`），去掉每元素栈帧捕获与 DEV 校验；
- 组件收窄 store 订阅（如 GeneralSettings 整店订阅改为两个 slice），减少重渲广度。

验证基准：四个 pin 文件的 `__snapshots__` 快照字节级零变化（md5 对比），且 4 路并行
压测多轮 17/17 全过。

## 回归防线

- `src/renderer/components/settings/*Group.pin.test.tsx`：快照本身即防线；
- `src/agent/backgroundTasks.windowsShell.test.ts` 的 mock 进程在 taskkill/测试边界
  收口（同批修复的 watchdog 跨测试泄漏）。

## 相关代码

`src/renderer/components/settings/pin.testUtils.tsx`（probe/effect/reset）、
`test/stubs/react-jsx-dev-runtime.ts`、`vitest.config.ts`、
`src/renderer/components/settings/GeneralSettings.tsx`
