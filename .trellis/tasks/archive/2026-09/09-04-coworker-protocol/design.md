# Design

## 1. coworker tool: `wait` / `report`

`src/agent/coworker.ts`

```ts
export interface CoworkerToolDeps {
  // existing: agentTypes, models, spawn, send, list, dismiss
  /** 阻塞至该 coworker 当前轮结束；空闲则立即返回最近一轮摘要。gate 同 send。 */
  wait(name: string, opts?: { signal?: AbortSignal; gate?: string }): Promise<string>;
  /** 最近一轮完整结果（不截断到 RESULT_LIMIT；上限 REPORT_LIMIT=20000）；从未跑过一轮 → '(no round completed yet)' */
  report(name: string): string;
}
```

- `operation` enum 增 `'wait' | 'report'`；两者都 `requires a name`。
- `wait` 返回 `truncate(result)`；`report` 返回 `truncateReport(result)`（20000 上限，尾注 `…(truncated at 20000 chars)`）。
- 对 `send`/`spawn`/`wait` 结果：若被 `truncate` 截断，尾注改为 `…(truncated — use coworker report {name} for the full text)`。
- description / promptSnippet 补一句：`wait {name}` 当没有别的事可做时用它等待，不要 sleep 轮询；`report {name}` 取完整报告。

`src/agent/supervisor.ts`

- `ManagedSession` 增 `lastRoundSummary?: string`（不含 gate 结果与 follow-up hint，纯 coworkerRoundSummary 的正文）；`coworkerSend` 两条路径在 `coworkerRoundSummary` 后写入。
- 异步通知里的 `summary.slice(0, 1500)` 被截断时追加 ` …(truncated — coworker report "<name>" for the full text)`。
- `coworkerWait(coworkerId, opts)`：若 `managed.status !== 'running'` 直接返回 `lastRoundSummary ?? '(no round completed yet)'`（含 gate）；否则订阅 `agent_end`（或 status 变化）等待，再走 `coworkerRoundSummary` 并写 `lastRoundSummary`。父 abort 与 send 同语义。

## 2. `message_main_agent` under blocking wait

`src/agent/messageMain.ts`

```ts
export function createMessageMainTool(
  notify: (text: string, urgent?: boolean) => void,
  coworkerName: string,
  isParentWaiting: () => boolean = () => false
): ToolDefinition
```

- `isParentWaiting()` 为 true 时：**不调用** notify，返回
  `(the main agent is blocked waiting on this round — your final message is delivered as the round result; no separate notice needed)`。
- 否则维持原行为。
- description 补：`If the main agent is already waiting on your current round, this is a no-op — just finish your turn.`

`supervisor.ts`：`ManagedSession` 增 `parentWaiting?: boolean`；`coworkerSend`/`coworkerWait` 阻塞路径 `try { managed.parentWaiting = true; … } finally { managed.parentWaiting = false }`；spawnCoworker 传 `() => this.sessions.get(coworkerId)?.parentWaiting === true`。

## 3. `writeScope` + `tester` agent type

`src/shared/types/assets.ts`

```ts
export interface AgentTypeEntry {
  …
  /** 可写路径 glob 白名单（相对 cwd，posix 分隔）；缺省不限。只约束 edit/write 工具。 */
  writeScope?: string[];
}
```

BUILTIN_AGENT_TYPES 增：
```ts
{
  name: 'tester',
  description: 'Writes failing tests first (RED); cannot touch implementation files',
  systemPrompt:
    'You are a test-first author. Write failing tests that pin down the contract described in the task, ' +
    'run them and confirm each fails because the behavior is missing (not because of a typo). ' +
    'Never write or edit implementation files — only test files. Read specs, type contracts and existing tests; ' +
    'avoid reading the implementation body of the module under test so the tests stay independent of it. ' +
    'Report the test files, case counts, and the exact failure reasons.',
  tools: 'all',
  writeScope: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', 'test/**'],
  modelMode: 'agent_pick',
}
```

`src/agent/writeScope.ts`（新，纯逻辑 + 包装）

```ts
/** 极简 glob → RegExp：`**` 任意层级（含空）、`*` 段内任意、`?` 单字符；其余字面。匹配整段 posix 相对路径。 */
export function globToRegExp(glob: string): RegExp
/** path 可为绝对或相对（相对 cwd 解析后取相对、posix 化）；越出 cwd（../）恒 false */
export function isPathInWriteScope(filePath: string, cwd: string, scope: readonly string[]): boolean
/** 包装 edit/write 类工具：参数 `path` 不在范围内 → throw Error(`write scope: "<rel>" is outside [${scope.join(', ')}]`)；范围为空/未定义 → 原样返回 */
export function withWriteScope<T extends ToolDefinition>(def: T, cwd: string, scope: readonly string[] | undefined): T
```

`supervisor.ts` `buildBaseTools`：edit / write 两个定义外层套 `withWriteScope(def, cwd, agentType?.writeScope)`（`createChildSession` 已能拿到 `agentType`）。

其它引用点：`src/shared/builtinAgents.ts`（内置类型登记）、`src/tooling/productCapabilityCoverage.fixture.ts`（BUILTIN_AGENT_TYPE_COVERAGE 需补 tester）、`src/shared/capabilities/catalog.ts` 若按名字枚举。

## Tests (TDD)

- `src/agent/coworker.test.ts`：wait/report 路由到 deps、缺 name 报错、report 20000 截断尾注、send 截断尾注含 report 提示、schema enum 含 wait/report、promptSnippet 提到 wait 替代 sleep。
- `src/agent/messageMain.test.ts`：isParentWaiting=true → notify 未调用、返回文案含 "waiting"；false → 原行为；缺省参数向后兼容。
- `src/agent/writeScope.test.ts`：globToRegExp（`**/*.test.ts` 命中 `a/b/c.test.ts` 与 `c.test.ts`；不命中 `c.ts`、`c.test.tsx`；`test/**` 命中 `test/x/y.ts`）；isPathInWriteScope（绝对路径解析、`../` 逃逸 false、Windows 反斜杠归一）；withWriteScope（越界 throw 且不调用内部 execute、范围内透传、scope undefined 原样返回同一对象）。
- `src/shared/builtinAgents` 相关既有测试若枚举内置类型数量需更新。
