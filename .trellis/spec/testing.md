# 测试规范

用 Vitest。配置在 `vitest.config.ts`，测试文件与被测模块**同目录同名**加 `.test.ts`。

```bash
pnpm test          # 单次运行
pnpm test:watch    # 监听模式
```

## 流程：测试先行（TDD）

在下方「测什么」覆盖的范围内改逻辑时，**先写失败测试再写实现**：

1. RED：写一个最小失败测试，运行确认它**因功能缺失而失败**——直接通过说明
   测的是既有行为，报错（而非断言失败）说明测试本身有问题，都要先修正；
2. GREEN：写最小实现让它通过，不顺手加功能、不夹带重构；
3. 全量 `pnpm test` 绿色后提交；重构在绿色基础上单独进行、单独提交。

修 bug 同理：先写复现失败的测试，修好后它就是回归防线。没有失败过的
测试不能证明任何东西。

逻辑面大的改动（跨模块、协议 / 解析器类）**强烈推荐** coworker 角色分离：
测试先行者用 `agent_type: tester`（只能写测试文件），实现者在红灯到手前不动手、
不许改测试文件。`spawn` 只派一刀切片，后续用 `send`；`wait` 带本刀测试的 `gate`，
以退出码验收（红=非 0，绿=另跑同一命令为 0）。
小纯函数（测试 < 50 行或用例 < 10）inline 即可。详见
[动手前检查清单 §1.5](guides/pre-implementation-checklist.md) 与 `AGENTS.md`。

## 测什么

当前覆盖的是**主进程的纯逻辑与解析器** —— 这些地方逻辑稳定、真出过 bug、
且不依赖 Electron 运行时：

| 测试文件 | 覆盖 |
|----------|------|
| `src/main/services/assetScan/dedupe.test.ts` | 技能与 MCP 的去重指纹 |
| `src/main/services/assetScan/mcp.test.ts` | 三家 MCP 配置格式的解析 |
| `src/main/services/assetScan/skills.test.ts` | SKILL.md frontmatter、插件包技能 |
| `src/main/services/assetScan/instructions.test.ts` | 指令文件的内容哈希去重 |
| `src/main/services/providerApi.test.ts` | URL 拼接、模型列表解析、错误文案 |
| `src/main/services/instructionStore.test.ts` | 路径穿越防护 |
| `src/shared/i18n.test.ts` | locale 归一化、插值 |
| `src/shared/types/agent.test.ts` | agent 命令/事件的收窄（脏输入不崩） |
| `src/agent/projection.test.ts` | 消息投影白名单（脱敏即白名单克隆） |
| `src/agent/gate.test.ts` | 操作门：同 key 串行、异 key 并行、抛错不断链 |
| `src/agent/sessionShell.test.ts` | 本地 win32 用官方 `powershell`，SSH/非 Windows 用 `bash` |
| `src/renderer/stores/sessions/reducer.test.ts` | 事件归并：seq 守卫、index upsert、截断 |

**暂未覆盖**（有意为之）：React 组件、zustand store、真实网络请求、Electron 窗口行为。
这些需要 jsdom 或真机环境，成本高且 UI 仍在快速迭代。
界面行为目前靠 CDP 真机验证，见 [shared/conventions.md](shared/conventions.md)。

## 优先测这几类

1. **身份判定**（什么算同一个）—— 去重指纹错了会静默地放过重复项
2. **字符串拼接与解析** —— URL 版本段、frontmatter、TOML/JSON 结构
3. **安全边界** —— 路径校验、输入收窄
4. **脏输入不崩** —— 外部应用的配置文件随时可能是缺字段、错类型、坏格式的

第 4 类尤其重要：本项目大量读取**别人写的**配置文件，容错是功能而不是防御性编程。
写用例时刻意传 `null`、非对象、类型不符的值。

## 私有函数怎么测

关键纯函数**加 `export`** 直接测，不要用 `// @ts-expect-error` 或访问内部字段绕。
已这样导出的：`resolveBase`、`withVersionSegment`、`extractModelIds`、`toMessage`、
`skillNameKey`、`mcpKey`、`parseServerMap`、`isValidId`。

判断标准：这个函数有独立的、值得写下来的契约吗？有就导出；
只是为了拆行的局部辅助函数不必。

## electron 依赖

主进程模块顶层会 `import { app } from 'electron'`，node 环境下无法解析。
`vitest.config.ts` 把 `electron` 别名到 `test/stubs/electron.ts` 的最小桩。
被测模块用到桩里没有的 API 时，往桩里补，不要改源码。

## 文件读取类怎么测

用临时目录做 fixture，**不要依赖本机实际配置**（`~/.claude/skills` 等）——
那样的测试在别人机器上会挂：

```ts
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-xxx-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
```

## 用例风格

- 用中文描述行为，说清**场景**而不是复述实现：
  `it('同一技能被多个工具各装一份时视为同一个')` 而不是 `it('returns lowercase')`。
- 来自真实排查的用例，用注释写明背景：
  `// 真实场景：同一个服务器在 Claude 里叫 cunzhi，在 Cursor 里叫寸止`
- 一个 `it` 验一件事，避免一个用例里堆十个断言。

## 参与模型的功能，真机验证至少跨两个厂商

凡是靠 LLM 调工具的链路（Enso 能力、subagent 派发等），**只用一个模型验证会漏掉整类 bug**。

实例：`enso_app` 的 `params` 没声明 `type`，Grok 传对象（恰好能用）、Claude 传
字符串化 JSON（被 inputSchema 判 `$ must be an object`，建类型三次全败）。
只测 Grok 时这个 bug 完全隐形。同一轮还暴露了第二个：`agent-types.list` 只给
`typeKey`、`delete` 只认裸 id，模型根本拿不到合法参数。

因此：

- 真机验收这类功能时，至少跑两个不同厂商的模型（如 xAI + Anthropic）
- 工具参数 schema **必须写 `type`**，不能只给 description 让模型自己猜
- 形态归一放 `prepareArguments`（schema 校验**之前**），放 `execute` 里就晚了
- 面向模型的 list 类能力开出什么标识，写入类能力就要能收什么标识

## 修 bug 时

先写一个能复现的失败用例，再改代码。
`extractModelIds` 在响应含 `null` 条目时抛异常就是这么发现的 ——
写"脏输入不崩"用例时暴露的。

来不及先写用例时（比如真机排查完才定位），**补完测试必须反向验一次**：
临时把修复改回去，确认新用例真的 fail，再恢复。
否则很容易写出“怎么改都绿”的假用例 —— 这类用例在真出问题时恰恰不报。

同样的道理：**断言可观测行为，不断言实现细节**。
验“文件落盘了”而不是“调用了 `_rewriteFile`”；
验“同一投影重复到达不再落盘”而不是“值是对的”（死循环里值一直是对的）。
